# Generates the Modpack Studio brand assets used by the Windows build and the
# bundled extension. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File build/win32/generate-branding.ps1
#
# The artwork is intentionally kept in code so the placeholder logo can be
# replaced by simply swapping the generated files.

param(
	[string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

public static class ModpackBranding
{
	private const int MasterSize = 1024;

	public static void Generate(string repoRoot)
	{
		using (var master = RenderIcon(MasterSize))
		{
			var win32 = Path.Combine(repoRoot, "resources", "win32");
			var extensionResources = Path.Combine(repoRoot, "extensions", "modpack-studio", "resources");
			Directory.CreateDirectory(win32);
			Directory.CreateDirectory(extensionResources);

			master.Save(Path.Combine(win32, "modpack-1024.png"), ImageFormat.Png);
			master.Save(Path.Combine(extensionResources, "icon.png"), ImageFormat.Png);

			SavePng(master, Path.Combine(win32, "code_150x150.png"), 150, 150);
			SavePng(master, Path.Combine(win32, "code_70x70.png"), 70, 70);

			var icoSizes = new[] { 16, 24, 32, 48, 64, 128, 256 };
			File.WriteAllBytes(Path.Combine(win32, "code.ico"), BuildIco(master, icoSizes));

			var bigSizes = new Dictionary<string, Size>
			{
				{ "100", new Size(164, 314) },
				{ "125", new Size(192, 386) },
				{ "150", new Size(246, 459) },
				{ "175", new Size(273, 556) },
				{ "200", new Size(328, 604) },
				{ "225", new Size(355, 700) },
				{ "250", new Size(410, 797) },
			};
			foreach (var pair in bigSizes)
			{
				using (var bmp = RenderInstallerBig(master, pair.Value.Width, pair.Value.Height))
				{
					bmp.Save(Path.Combine(win32, "inno-big-" + pair.Key + ".bmp"), ImageFormat.Bmp);
				}
			}

			var smallSizes = new Dictionary<string, Size>
			{
				{ "100", new Size(55, 55) },
				{ "125", new Size(64, 68) },
				{ "150", new Size(83, 80) },
				{ "175", new Size(92, 97) },
				{ "200", new Size(110, 106) },
				{ "225", new Size(119, 123) },
				{ "250", new Size(138, 140) },
			};
			foreach (var pair in smallSizes)
			{
				using (var bmp = RenderInstallerSmall(master, pair.Value.Width, pair.Value.Height))
				{
					bmp.Save(Path.Combine(win32, "inno-small-" + pair.Key + ".bmp"), ImageFormat.Bmp);
				}
			}
		}
	}

	private static Bitmap RenderIcon(int size)
	{
		var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
		using (var g = Graphics.FromImage(bmp))
		{
			g.SmoothingMode = SmoothingMode.AntiAlias;
			g.InterpolationMode = InterpolationMode.HighQualityBicubic;
			g.PixelOffsetMode = PixelOffsetMode.HighQuality;
			g.CompositingQuality = CompositingQuality.HighQuality;
			g.Clear(Color.Transparent);

			float s = size / 1024f;
			g.ScaleTransform(s, s);

			using (var background = RoundedRect(new RectangleF(22, 22, 980, 980), 216))
			using (var brush = new LinearGradientBrush(
				new PointF(40, 20),
				new PointF(980, 1000),
				Color.FromArgb(255, 18, 58, 44),
				Color.FromArgb(255, 4, 16, 12)))
			{
				g.FillPath(brush, background);
				using (var border = new Pen(Color.FromArgb(84, 120, 240, 168), 7f))
				{
					g.DrawPath(border, background);
				}
			}

			// Faint pixel grid keeps the icon close to the blocky Minecraft look.
			using (var grid = new Pen(Color.FromArgb(6, 255, 255, 255), 2f))
			{
				for (int i = 1; i < 12; i++)
				{
					float p = i * 1024f / 12f;
					g.DrawLine(grid, p, 90, p, 934);
					g.DrawLine(grid, 90, p, 934, p);
				}
			}

			// Soft green glow behind the block.
			using (var glow = new GraphicsPath())
			{
				glow.AddEllipse(170, 180, 684, 684);
				using (var pathBrush = new PathGradientBrush(glow))
				{
					pathBrush.CenterColor = Color.FromArgb(90, 84, 226, 132);
					pathBrush.SurroundColors = new[] { Color.FromArgb(0, 84, 226, 132) };
					g.FillPath(pathBrush, glow);
				}
			}

			DrawBlock(g, 512, 470, 1.0f);
			DrawTerminalBadge(g);
			DrawSpark(g, 214, 238, 34, 140);
			DrawSpark(g, 806, 292, 24, 110);
			DrawSpark(g, 792, 760, 18, 80);
			DrawSpark(g, 236, 700, 12, 60);
		}
		return bmp;
	}

	private static void DrawBlock(Graphics g, float cx, float cy, float scale)
	{
		g.TranslateTransform(cx, cy);
		if (scale != 1f)
		{
			g.ScaleTransform(scale, scale);
		}

		float top = -252;
		float middle = 0;
		float bottom = 252;
		float halfWidth = 252;
		float grass = 100;

		// Top face: bright grass green.
		var topFace = new[]
		{
			new PointF(0, top),
			new PointF(halfWidth, -126),
			new PointF(0, middle),
			new PointF(-halfWidth, -126),
		};
		using (var brush = new LinearGradientBrush(
			new PointF(-halfWidth, top),
			new PointF(halfWidth, middle),
			Color.FromArgb(255, 150, 245, 136),
			Color.FromArgb(255, 74, 196, 90)))
		{
			g.FillPolygon(brush, topFace);
		}
		using (var edge = new Pen(Color.FromArgb(255, 186, 255, 172), 6f))
		{
			g.DrawPolygon(edge, topFace);
		}

		// Left face: grass strip + dirt.
		using (var grassBrush = new LinearGradientBrush(
			new PointF(-halfWidth, -126),
			new PointF(0, bottom),
			Color.FromArgb(255, 82, 194, 94),
			Color.FromArgb(255, 52, 142, 68)))
		{
			g.FillPolygon(grassBrush, new[]
			{
				new PointF(-halfWidth, -126),
				new PointF(0, middle),
				new PointF(0, middle + grass),
				new PointF(-halfWidth, -126 + grass),
			});
		}
		using (var dirtBrush = new LinearGradientBrush(
			new PointF(-halfWidth, middle),
			new PointF(0, bottom),
			Color.FromArgb(255, 126, 82, 49),
			Color.FromArgb(255, 92, 58, 34)))
		{
			g.FillPolygon(dirtBrush, new[]
			{
				new PointF(-halfWidth, -126 + grass),
				new PointF(0, middle + grass),
				new PointF(0, bottom),
				new PointF(-halfWidth, bottom - 126),
			});
		}

		// Right face: shadow side.
		using (var grassBrush = new LinearGradientBrush(
			new PointF(0, middle),
			new PointF(halfWidth, bottom),
			Color.FromArgb(255, 60, 168, 76),
			Color.FromArgb(255, 36, 108, 52)))
		{
			g.FillPolygon(grassBrush, new[]
			{
				new PointF(halfWidth, -126),
				new PointF(0, middle),
				new PointF(0, middle + grass),
				new PointF(halfWidth, -126 + grass),
			});
		}
		using (var dirtBrush = new LinearGradientBrush(
			new PointF(0, middle),
			new PointF(halfWidth, bottom),
			Color.FromArgb(255, 99, 62, 37),
			Color.FromArgb(255, 68, 41, 24)))
		{
			g.FillPolygon(dirtBrush, new[]
			{
				new PointF(halfWidth, -126 + grass),
				new PointF(0, middle + grass),
				new PointF(0, bottom),
				new PointF(halfWidth, bottom - 126),
			});
		}

		// Subtle vertical seams.
		using (var seam = new Pen(Color.FromArgb(46, 0, 0, 0), 4f))
		{
			g.DrawLine(seam, 0, middle + grass, 0, bottom);
			g.DrawLine(seam, -halfWidth, -126 + grass, 0, middle + grass);
			g.DrawLine(seam, 0, middle + grass, halfWidth, -126 + grass);
		}

		// Outline the two side faces.
		using (var edge = new Pen(Color.FromArgb(255, 26, 74, 44), 6f))
		{
			g.DrawPolygon(edge, new[]
			{
				new PointF(0, top),
				new PointF(halfWidth, -126),
				new PointF(halfWidth, bottom - 126),
				new PointF(0, bottom),
				new PointF(-halfWidth, bottom - 126),
				new PointF(-halfWidth, -126),
			});
			g.DrawLine(edge, 0, middle, 0, bottom);
		}

		g.ResetTransform();
	}

	private static void DrawTerminalBadge(Graphics g)
	{
		var rect = new RectangleF(538, 594, 302, 190);

		using (var shadowPath = RoundedRect(new RectangleF(rect.X + 14, rect.Y + 20, rect.Width, rect.Height), 44))
		using (var shadowBrush = new SolidBrush(Color.FromArgb(96, 0, 0, 0)))
		{
			g.FillPath(shadowBrush, shadowPath);
		}

		using (var path = RoundedRect(rect, 44))
		using (var brush = new LinearGradientBrush(
			new PointF(rect.Left, rect.Top),
			new PointF(rect.Right, rect.Bottom),
			Color.FromArgb(255, 16, 46, 33),
			Color.FromArgb(255, 6, 20, 14)))
		{
			g.FillPath(brush, path);
			using (var border = new Pen(Color.FromArgb(255, 96, 224, 140), 7f))
			{
				g.DrawPath(border, path);
			}
		}

		using (var font = new Font("Consolas", 112f, FontStyle.Bold, GraphicsUnit.Pixel))
		using (var textBrush = new SolidBrush(Color.FromArgb(255, 176, 255, 200)))
		using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
		{
			g.DrawString(">_", font, textBrush, new RectangleF(rect.X, rect.Y - 8, rect.Width, rect.Height), format);
		}
	}

	private static void DrawSpark(Graphics g, float x, float y, float size, int alpha)
	{
		using (var brush = new SolidBrush(Color.FromArgb(alpha, 158, 255, 190)))
		{
			var points = new[]
			{
				new PointF(x, y - size),
				new PointF(x + size, y),
				new PointF(x, y + size),
				new PointF(x - size, y),
			};
			g.FillPolygon(brush, points);
		}
	}

	private static Bitmap RenderInstallerBig(Bitmap master, int width, int height)
	{
		var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
		using (var g = Graphics.FromImage(bmp))
		{
			g.SmoothingMode = SmoothingMode.AntiAlias;
			g.InterpolationMode = InterpolationMode.HighQualityBicubic;
			g.PixelOffsetMode = PixelOffsetMode.HighQuality;
			g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

			using (var brush = new LinearGradientBrush(
				new PointF(0, 0),
				new PointF(width, height),
				Color.FromArgb(255, 20, 64, 48),
				Color.FromArgb(255, 5, 18, 13)))
			{
				g.FillRectangle(brush, 0, 0, width, height);
			}

			using (var glow = new GraphicsPath())
			{
				glow.AddEllipse(-width * 0.35f, height * 0.03f, width * 1.7f, width * 1.7f);
				using (var pathBrush = new PathGradientBrush(glow))
				{
					pathBrush.CenterColor = Color.FromArgb(58, 80, 226, 130);
					pathBrush.SurroundColors = new[] { Color.FromArgb(0, 80, 226, 130) };
					g.FillPath(pathBrush, glow);
				}
			}

			float scale = width / 164f;
			float contentHeight = 314f * scale;
			float offsetY = (height - contentHeight) / 2f;

			int iconSize = (int)Math.Round(96 * scale);
			using (var icon = new Bitmap(master, iconSize, iconSize))
			{
				g.DrawImage(icon, (width - iconSize) / 2f, offsetY + 30 * scale, iconSize, iconSize);
			}

			using (var titleFont = new Font("Segoe UI", 17f * scale, FontStyle.Bold, GraphicsUnit.Pixel))
			using (var titleBrush = new SolidBrush(Color.FromArgb(255, 236, 255, 243)))
			using (var center = new StringFormat { Alignment = StringAlignment.Center })
			{
				g.DrawString("MODPACK", titleFont, titleBrush, new RectangleF(0, offsetY + 140 * scale, width, 26 * scale), center);
				g.DrawString("STUDIO", titleFont, titleBrush, new RectangleF(0, offsetY + 168 * scale, width, 26 * scale), center);
			}

			using (var accent = new SolidBrush(Color.FromArgb(255, 96, 220, 128)))
			{
				float lineWidth = 58 * scale;
				g.FillRectangle(accent, (width - lineWidth) / 2f, offsetY + 206 * scale, lineWidth, Math.Max(2f, 3 * scale));
			}

			if (width >= 240)
			{
				using (var tagFont = new Font("Microsoft YaHei UI", 9.5f * scale, FontStyle.Regular, GraphicsUnit.Pixel))
				using (var tagBrush = new SolidBrush(Color.FromArgb(216, 188, 232, 208)))
				using (var center = new StringFormat { Alignment = StringAlignment.Center })
				{
					g.DrawString("Minecraft \u6574\u5408\u5305", tagFont, tagBrush, new RectangleF(0, offsetY + 222 * scale, width, 14 * scale), center);
					g.DrawString("\u5f00\u53d1\u5de5\u4f5c\u53f0", tagFont, tagBrush, new RectangleF(0, offsetY + 238 * scale, width, 14 * scale), center);
				}
			}

			// Bottom pixel steps add a playful blocky rhythm.
			using (var blockBrush = new SolidBrush(Color.FromArgb(34, 140, 240, 160)))
			{
				int cells = 9;
				float cell = width / (float)cells;
				for (int i = 0; i < cells; i++)
				{
					if ((i * 7) % 3 != 0)
					{
						continue;
					}
					float h = 6 + ((i * 5) % 4) * 3;
					g.FillRectangle(blockBrush, i * cell, height - h - 8 * scale, cell * 0.72f, h);
				}
			}
		}
		return bmp;
	}

	private static Bitmap RenderInstallerSmall(Bitmap master, int width, int height)
	{
		var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
		using (var g = Graphics.FromImage(bmp))
		{
			g.SmoothingMode = SmoothingMode.AntiAlias;
			g.InterpolationMode = InterpolationMode.HighQualityBicubic;
			g.PixelOffsetMode = PixelOffsetMode.HighQuality;

			using (var brush = new LinearGradientBrush(
				new PointF(0, 0),
				new PointF(width, height),
				Color.FromArgb(255, 20, 64, 48),
				Color.FromArgb(255, 5, 18, 13)))
			{
				g.FillRectangle(brush, 0, 0, width, height);
			}

			int margin = Math.Max(2, (int)Math.Round(Math.Min(width, height) * 0.08));
			int size = Math.Min(width, height) - margin * 2;
			using (var icon = new Bitmap(master, size, size))
			{
				g.DrawImage(icon, (width - size) / 2f, (height - size) / 2f, size, size);
			}
		}
		return bmp;
	}

	private static void SavePng(Bitmap master, string path, int width, int height)
	{
		using (var bmp = new Bitmap(master, width, height))
		{
			bmp.Save(path, ImageFormat.Png);
		}
	}

	private static byte[] BuildIco(Bitmap master, int[] sizes)
	{
		var frames = new List<byte[]>();
		foreach (var size in sizes)
		{
			using (var bmp = new Bitmap(master, size, size))
			using (var ms = new MemoryStream())
			{
				bmp.Save(ms, ImageFormat.Png);
				frames.Add(ms.ToArray());
			}
		}

		using (var ms = new MemoryStream())
		using (var writer = new BinaryWriter(ms))
		{
			writer.Write((ushort)0);
			writer.Write((ushort)1);
			writer.Write((ushort)sizes.Length);
			int offset = 6 + 16 * sizes.Length;
			for (int i = 0; i < sizes.Length; i++)
			{
				int size = sizes[i];
				writer.Write((byte)(size >= 256 ? 0 : size));
				writer.Write((byte)(size >= 256 ? 0 : size));
				writer.Write((byte)0);
				writer.Write((byte)0);
				writer.Write((ushort)1);
				writer.Write((ushort)32);
				writer.Write((uint)frames[i].Length);
				writer.Write((uint)offset);
				offset += frames[i].Length;
			}
			foreach (var frame in frames)
			{
				writer.Write(frame);
			}
			writer.Flush();
			return ms.ToArray();
		}
	}

	private static GraphicsPath RoundedRect(RectangleF rect, float radius)
	{
		var path = new GraphicsPath();
		float diameter = radius * 2;
		path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
		path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
		path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
		path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90);
		path.CloseFigure();
		return path;
	}
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing

[ModpackBranding]::Generate($RepoRoot)

Write-Host "Branding assets written to $RepoRoot\resources\win32"
