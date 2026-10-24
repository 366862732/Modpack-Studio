import { Client, Pool, type PoolConfig } from 'pg';
import * as vscode from 'vscode';

const DEFAULT_DATABASE = 'modpack_studio';
const PASSWORD_KEY = 'modpack.postgres.password';

export interface DbSearchHit {
	project_id: string;
	slug: string;
	title: string;
	description: string;
	author: string;
	downloads: number;
	icon_url?: string;
	categories: string[];
}

export interface DbVersion {
	id: string;
	project_id: string;
	name: string;
	version_number: string;
	version_type: string;
	game_versions: string[];
	loaders: string[];
	files: Array<{
		url: string;
		filename: string;
		size: number;
		hashes: { sha1?: string; sha512?: string };
	}>;
	date_published: string;
}

export interface DbInstalledRecord {
	fileName: string;
	projectId?: string;
	versionId?: string;
	name?: string;
	versionNumber?: string;
	enabled: boolean;
	source: string;
	installedAt?: string;
}

interface PostgresSettings {
	host: string;
	port: number;
	user: string;
	database: string;
	password: string;
}

/**
 * Stores the Modrinth catalog and per-instance install records in PostgreSQL.
 *
 * The database is optional: instance metadata and launcher files stay in local
 * JSON so the IDE keeps working when PostgreSQL is stopped or unreachable.
 */
export class DatabaseService {
	private pool: Pool | undefined;
	private state: 'disabled' | 'starting' | 'ready' | 'error' = 'disabled';
	private lastError: string | undefined;
	private readonly changed = new vscode.EventEmitter<void>();

	readonly onDidChange = this.changed.event;

	constructor(private readonly context: vscode.ExtensionContext) { }

	get available(): boolean {
		return this.state === 'ready';
	}

	get failed(): boolean {
		return this.state === 'error';
	}

	get statusText(): string {
		switch (this.state) {
			case 'ready': return 'PostgreSQL 已连接';
			case 'starting': return 'PostgreSQL 正在连接…';
			case 'error': return `PostgreSQL 不可用${this.lastError ? `：${this.lastError}` : ''}`;
			default: return 'PostgreSQL 未启用';
		}
	}

	async initialize(): Promise<void> {
		await this.stop();
		if (!vscode.workspace.getConfiguration('modpack').get<boolean>('postgres.enabled', true)) {
			this.state = 'disabled';
			this.changed.fire();
			return;
		}
		this.state = 'starting';
		this.lastError = undefined;
		this.changed.fire();

		try {
			const settings = await this.readSettings();
			this.pool = await this.createPool(settings);
			await this.ensureSchema();
			this.state = 'ready';
		} catch (error) {
			this.state = 'error';
			this.lastError = shortError(error);
			await this.stop();
			console.warn('[modpack-studio] PostgreSQL 连接失败，将使用本地数据', error);
		}
		this.changed.fire();
	}

	/** Verifies the current settings without replacing the active pool. */
	async testExternal(): Promise<string> {
		const settings = await this.readSettings();
		const client = new Client(this.poolConfig(settings, 'postgres'));
		await client.connect();
		try {
			const result = await client.query<{ version: string }>('SELECT version() AS version');
			return result.rows[0]?.version ?? 'unknown';
		} finally {
			await client.end().catch(() => undefined);
		}
	}

	private async readSettings(): Promise<PostgresSettings> {
		const config = vscode.workspace.getConfiguration('modpack');
		let password = await this.context.secrets.get(PASSWORD_KEY) ?? '';
		if (!password) {
			password = config.get<string>('postgres.password', '') ?? '';
		}
		if (!password) {
			password = process.env.PGPASSWORD ?? '';
		}
		return {
			host: config.get<string>('postgres.host', '127.0.0.1'),
			port: config.get<number>('postgres.port', 5432),
			user: config.get<string>('postgres.user', 'postgres'),
			database: config.get<string>('postgres.database', DEFAULT_DATABASE) || DEFAULT_DATABASE,
			password
		};
	}

	private poolConfig(settings: PostgresSettings, database: string): PoolConfig {
		return {
			host: settings.host,
			port: settings.port,
			user: settings.user,
			password: settings.password,
			database,
			max: 4,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
			application_name: 'Modpack Studio'
		};
	}

	/**
	 * Connects to the configured database. When it does not exist yet the same
	 * credentials are used to create it (requires the CREATEDB privilege).
	 */
	private async createPool(settings: PostgresSettings): Promise<Pool> {
		let pool = new Pool(this.poolConfig(settings, settings.database));
		try {
			await pool.query('SELECT 1');
			return pool;
		} catch (error) {
			await pool.end().catch(() => undefined);
			if ((error as { code?: string }).code !== '3D000') {
				throw error;
			}
		}

		const admin = new Client(this.poolConfig(settings, 'postgres'));
		await admin.connect();
		try {
			const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [settings.database]);
			if (exists.rowCount === 0) {
				try {
					await admin.query(`CREATE DATABASE ${quoteIdentifier(settings.database)}`);
				} catch (error) {
					throw new Error(`数据库 ${settings.database} 不存在，且当前用户无法创建它：${shortError(error)}`);
				}
			}
		} finally {
			await admin.end().catch(() => undefined);
		}

		pool = new Pool(this.poolConfig(settings, settings.database));
		await pool.query('SELECT 1');
		return pool;
	}

	private async ensureSchema(): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		const statements = [
			`CREATE TABLE IF NOT EXISTS mods (
				project_id VARCHAR(64) NOT NULL PRIMARY KEY,
				slug VARCHAR(191) NULL,
				title VARCHAR(255) NOT NULL,
				description TEXT NULL,
				author VARCHAR(255) NULL,
				downloads BIGINT NOT NULL DEFAULT 0,
				icon_url TEXT NULL,
				categories JSONB NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`,
			`CREATE TABLE IF NOT EXISTS mod_versions (
				version_id VARCHAR(64) NOT NULL PRIMARY KEY,
				project_id VARCHAR(64) NOT NULL,
				name VARCHAR(255) NULL,
				version_number VARCHAR(64) NULL,
				version_type VARCHAR(16) NULL,
				game_versions JSONB NULL,
				loaders JSONB NULL,
				download_url TEXT NULL,
				file_name VARCHAR(255) NULL,
				file_size BIGINT NULL,
				sha1 CHAR(40) NULL,
				sha512 CHAR(128) NULL,
				published_at TIMESTAMPTZ NULL
			)`,
			'CREATE INDEX IF NOT EXISTS mod_versions_project_idx ON mod_versions (project_id)',
			'CREATE INDEX IF NOT EXISTS mod_versions_published_idx ON mod_versions (published_at)',
			`CREATE TABLE IF NOT EXISTS installed_mods (
				instance_id VARCHAR(191) NOT NULL,
				file_name VARCHAR(255) NOT NULL,
				project_id VARCHAR(64) NULL,
				version_id VARCHAR(64) NULL,
				name VARCHAR(255) NULL,
				version_number VARCHAR(64) NULL,
				enabled BOOLEAN NOT NULL DEFAULT TRUE,
				source VARCHAR(16) NOT NULL DEFAULT 'local',
				installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				PRIMARY KEY (instance_id, file_name)
			)`,
			`CREATE TABLE IF NOT EXISTS export_history (
				id BIGSERIAL PRIMARY KEY,
				instance_id VARCHAR(191) NOT NULL,
				format VARCHAR(16) NOT NULL,
				file_path TEXT NULL,
				mod_count INTEGER NOT NULL DEFAULT 0,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`,
			'CREATE INDEX IF NOT EXISTS export_history_instance_idx ON export_history (instance_id)'
		];
		for (const statement of statements) {
			await pool.query(statement);
		}
	}

	async recordSearch(hits: DbSearchHit[]): Promise<void> {
		const pool = this.pool;
		if (!pool || !hits.length) {
			return;
		}
		try {
			for (const hit of hits) {
				await pool.query(
					`INSERT INTO mods (project_id, slug, title, description, author, downloads, icon_url, categories)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
					 ON CONFLICT (project_id) DO UPDATE SET
					 	slug = EXCLUDED.slug,
					 	title = EXCLUDED.title,
					 	description = EXCLUDED.description,
					 	author = EXCLUDED.author,
					 	downloads = EXCLUDED.downloads,
					 	icon_url = EXCLUDED.icon_url,
					 	categories = EXCLUDED.categories,
					 	updated_at = now()`,
					[
						hit.project_id,
						hit.slug.slice(0, 191),
						hit.title.slice(0, 255),
						hit.description ?? '',
						(hit.author ?? '').slice(0, 255),
						hit.downloads ?? 0,
						hit.icon_url ?? '',
						JSON.stringify(hit.categories ?? [])
					]
				);
			}
		} catch (error) {
			console.warn('[modpack-studio] 写入模组索引失败', error);
		}
	}

	async recordVersion(version: DbVersion): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		const file = version.files.find(candidate => candidate.filename) ?? version.files[0];
		if (!file) {
			return;
		}
		const published = version.date_published ? new Date(version.date_published) : undefined;
		try {
			await pool.query(
				`INSERT INTO mod_versions
				 (version_id, project_id, name, version_number, version_type, game_versions, loaders, download_url, file_name, file_size, sha1, sha512, published_at)
				 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13)
				 ON CONFLICT (version_id) DO UPDATE SET
				 	name = EXCLUDED.name,
				 	download_url = EXCLUDED.download_url,
				 	file_name = EXCLUDED.file_name`,
				[
					version.id,
					version.project_id,
					version.name?.slice(0, 255) ?? '',
					version.version_number?.slice(0, 64) ?? '',
					version.version_type ?? '',
					JSON.stringify(version.game_versions ?? []),
					JSON.stringify(version.loaders ?? []),
					file.url,
					file.filename,
					file.size,
					file.hashes.sha1 ?? null,
					file.hashes.sha512 ?? null,
					published && !Number.isNaN(published.getTime()) ? published : null
				]
			);
		} catch (error) {
			console.warn('[modpack-studio] 写入模组版本失败', error);
		}
	}

	async recordInstalled(instanceId: string, record: DbInstalledRecord): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		try {
			await pool.query(
				`INSERT INTO installed_mods
				 (instance_id, file_name, project_id, version_id, name, version_number, enabled, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 ON CONFLICT (instance_id, file_name) DO UPDATE SET
				 	project_id = EXCLUDED.project_id,
				 	version_id = EXCLUDED.version_id,
				 	name = EXCLUDED.name,
				 	version_number = EXCLUDED.version_number,
				 	enabled = EXCLUDED.enabled,
				 	source = EXCLUDED.source`,
				[
					instanceId,
					record.fileName,
					record.projectId ?? '',
					record.versionId ?? '',
					record.name?.slice(0, 255) ?? '',
					record.versionNumber?.slice(0, 64) ?? '',
					record.enabled,
					record.source
				]
			);
		} catch (error) {
			console.warn('[modpack-studio] 写入安装记录失败', error);
		}
	}

	async setEnabled(instanceId: string, fileName: string, enabled: boolean): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		try {
			await pool.query(
				'UPDATE installed_mods SET enabled = $1 WHERE instance_id = $2 AND file_name = $3',
				[enabled, instanceId, fileName]
			);
		} catch (error) {
			console.warn('[modpack-studio] 更新模组状态失败', error);
		}
	}

	async removeInstalled(instanceId: string, fileName: string): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		try {
			await pool.query('DELETE FROM installed_mods WHERE instance_id = $1 AND file_name = $2', [instanceId, fileName]);
		} catch (error) {
			console.warn('[modpack-studio] 删除安装记录失败', error);
		}
	}

	async recordExport(instanceId: string, format: string, filePath: string, modCount: number): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		try {
			await pool.query(
				'INSERT INTO export_history (instance_id, format, file_path, mod_count) VALUES ($1, $2, $3, $4)',
				[instanceId, format, filePath, modCount]
			);
		} catch (error) {
			console.warn('[modpack-studio] 写入导出记录失败', error);
		}
	}

	async getStats(): Promise<{ mods: number; versions: number; installed: number; exports: number } | undefined> {
		const pool = this.pool;
		if (!pool) {
			return undefined;
		}
		try {
			const [mods, versions, installed, exports] = await Promise.all([
				pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM mods'),
				pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM mod_versions'),
				pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM installed_mods'),
				pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM export_history')
			]);
			return {
				mods: Number(mods.rows[0]?.count ?? 0),
				versions: Number(versions.rows[0]?.count ?? 0),
				installed: Number(installed.rows[0]?.count ?? 0),
				exports: Number(exports.rows[0]?.count ?? 0)
			};
		} catch {
			return undefined;
		}
	}

	private async stop(): Promise<void> {
		const pool = this.pool;
		this.pool = undefined;
		if (pool) {
			await pool.end().catch(() => undefined);
		}
	}

	dispose(): void {
		void this.stop();
		this.changed.dispose();
	}
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(/\r?\n/)[0].slice(0, 200);
}

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
