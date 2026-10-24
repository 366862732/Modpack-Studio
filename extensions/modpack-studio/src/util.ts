import * as crypto from 'node:crypto';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const USER_AGENT = 'ModpackStudio/0.1.0 (Minecraft modpack IDE)';

// Several Minecraft services (Modrinth, NeoForge Maven, some Mojang CDNs)
// publish AAAA records whose IPv6 route is unreachable on common networks.
// Node tries addresses in resolver order and does not retry over IPv4 after a
// connect timeout, so prefer IPv4 for every outgoing request made by the IDE.
dns.setDefaultResultOrder('ipv4first');

export async function ensureDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.promises.access(target);
		return true;
	} catch {
		return false;
	}
}

export async function readJson<T>(file: string, fallback?: T): Promise<T> {
	try {
		const text = await fs.promises.readFile(file, 'utf8');
		return JSON.parse(stripBom(text)) as T;
	} catch (error) {
		if (fallback !== undefined) {
			return fallback;
		}
		throw error;
	}
}

export async function writeJson(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.promises.writeFile(file, `${JSON.stringify(value, undefined, '\t')}\n`, 'utf8');
}

export async function readText(file: string): Promise<string> {
	return fs.promises.readFile(file, 'utf8');
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function slugify(name: string): string {
	const base = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return base || `pack-${Date.now().toString(36)}`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function requestStream(
	url: string,
	headers: Record<string, string>,
	abortSignal?: AbortSignal,
	redirects = 5
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(abortSignal.reason ?? new Error('下载已取消'));
			return;
		}
		const client = url.startsWith('http:') ? http : https;
		const request = client.get(url, { headers, signal: abortSignal }, response => {
			const status = response.statusCode ?? 0;
			// Resume an interrupted download when the server supports Range.
			if (status === 206) {
				resolve(response);
				return;
			}
			if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
				response.resume();
				const next = new URL(response.headers.location, url).toString();
				resolve(requestStream(next, headers, abortSignal, redirects - 1));
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`下载失败 (HTTP ${status}): ${url}`));
				return;
			}
			resolve(response);
		});
		request.on('error', reject);
		request.setTimeout(60_000, () => {
			request.destroy(new Error(`下载超时: ${url}`));
		});
		if (abortSignal) {
			abortSignal.addEventListener('abort', () => request.destroy(abortSignal.reason ?? new Error('下载已取消')), { once: true });
		}
	});
}

/**
 * Downloads a URL into a file atomically. The file is written to
 * `<target>.<pid>.part` first so an interrupted download never leaves a
 * corrupt jar behind.  When `resume` is true the downloader resumes an
 * existing `.part` file via a Range request, mirroring PCL's adaptive
 * partial-download behaviour.
 */
export async function downloadFile(
	url: string,
	target: string,
	headers: Record<string, string> = {},
	attempts = 2,
	abortSignal?: AbortSignal,
	resume = false
): Promise<void> {
	await ensureDir(path.dirname(target));
	const temporary = `${target}.${process.pid}.part`;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (abortSignal?.aborted) {
			throw abortSignal.reason ?? new Error('下载已取消');
		}
		try {
			let offset = 0;
			if (resume) {
				try {
					offset = await fs.promises.stat(temporary).then(s => s.size);
				} catch {
					offset = 0;
				}
			}
			const requestHeaders = { 'User-Agent': USER_AGENT, ...headers };
			if (offset > 0) {
				requestHeaders['Range'] = `bytes=${offset}-`;
			}
			const response = await requestStream(url, requestHeaders, abortSignal);
			const status = response.statusCode ?? 0;
			// Server ignored the Range header and returned the full body.
			if (offset > 0 && status === 200) {
				offset = 0;
			}
			const flags = offset > 0 ? fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT : 'w';
			await pipeline(response, fs.createWriteStream(temporary, { flags: offset > 0 ? 'a' : 'w' }));
			await fs.promises.rename(temporary, target);
			return;
		} catch (error) {
			lastError = error;
			// Do not clean up the .part file when resuming is requested so
			// the next attempt can continue where this one left off.
			if (!resume) {
				await fs.promises.rm(temporary, { force: true });
			}
			if (abortSignal?.aborted) {
				throw abortSignal.reason ?? new Error('下载已取消');
			}
			if (attempt < attempts) {
				await delay(600);
			}
		}
	}
	throw lastError;
}

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error: unknown): boolean {
	if (error instanceof Error) {
		// HTTP status errors mean the server answered: retrying will not help
		// unless the status itself is transient (429/5xx).
		const status = /HTTP (\d{3})/.exec(error.message);
		if (status) {
			const code = Number.parseInt(status[1], 10);
			return code === 429 || code >= 500;
		}
	}
	return true;
}

/**
 * Fetches JSON with a generous timeout and one retry. The retry matters on
 * networks where the first connection silently stalls before DNS/route
 * selection settles on a working address family.
 */
export async function fetchJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 45_000): Promise<T> {
	const text = await fetchText(url, headers, timeoutMs);
	try {
		return JSON.parse(stripBom(text)) as T;
	} catch {
		throw new Error(`响应不是有效的 JSON: ${url}`);
	}
}

export async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 45_000, attempts = 2): Promise<string> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, {
				headers: {
					'User-Agent': USER_AGENT,
					'Accept': 'application/json, text/plain, */*',
					...headers
				},
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`请求失败 (HTTP ${response.status}): ${url}`);
			}
			return await response.text();
		} catch (error) {
			lastError = error;
			if (!isRetryableNetworkError(error) || attempt >= attempts) {
				throw error;
			}
		} finally {
			clearTimeout(timeout);
		}
		await delay(600);
	}
	throw lastError;
}

export async function hashFile(file: string, algorithm: 'sha1' | 'sha512' | 'md5'): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash(algorithm);
		const stream = fs.createReadStream(file);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/** Java's UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8)) */
export function offlineUuid(name: string): string {
	const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
	hash[6] = (hash[6] & 0x0f) | 0x30;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = hash.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseJavaMajor(version: string): number | undefined {
	const normalized = version.trim();
	const legacy = /^1\.(\d+)/.exec(normalized);
	if (legacy) {
		return Number.parseInt(legacy[1], 10);
	}
	const modern = /^(\d+)/.exec(normalized);
	return modern ? Number.parseInt(modern[1], 10) : undefined;
}

export function javaExecutableName(): string {
	return process.platform === 'win32' ? 'java.exe' : 'java';
}

export function defaultHome(): string {
	return path.join(os.homedir(), 'ModpackStudio');
}

/** Shared storage for automatically downloaded Java runtimes. */
export function runtimeHome(): string {
	return path.join(os.homedir(), '.modpack-studio', 'runtime');
}

export function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function samePath(a: string, b: string): boolean {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
