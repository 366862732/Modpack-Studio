using PCL.Core.Utils.Exts;
using PCL.Core.Utils.OS;

namespace PCL.Core.App;

// ReSharper disable InconsistentNaming
public static class Secrets
{
    /// <summary>
    /// 微软 OAuth 的 Client ID (填入你申请的那个)
    /// </summary>
    public static string MSOAuthClientId { get; } = "1f9be640-9d87-4dc7-acd4-4a1e186557fc";

    /// <summary>
    /// CurseForge API 的 Client ID (填入刚才找的公开 Key，测你的模组用)
    /// </summary>
    public static string CurseForgeAPIKey { get; } = "$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm";

    /// <summary>
    /// 遥测密钥 (留空，保护隐私，且代码有容错不会崩溃)
    /// </summary>
    public static string TelemetryKey { get; } = "";

    /// <summary>
    /// Natayark ID OAuth 的 Client ID (留空，没配不会闪退)
    /// </summary>
    public static string NatayarkClientId { get; } = "";

    /// <summary>
    /// Natayark ID OAuth 的 Client Secret (留空)
    /// </summary>
    public static string NatayarkClientSecret { get; } = "";

    /// <summary>
    /// 联机根服务器 (🔥 极其重要：必须给一个默认值，防止 Split 报错闪退)
    /// 这里填入的是 PCL-CE 官方常用的公共联机服务器地址
    /// </summary>
    public static string[] LinkServers { get; } = new[] { "https://link.pysio.online/" };

    /// <summary>
    /// 当前版本的 Git 提交 SHA (写死一个伪装版本号)
    /// </summary>
    public static string CommitHash { get; } = "ce-custom-build-2026";
}