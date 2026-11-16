'use strict';

/**
 * Everything here is derived directly from the Aether core source
 * (cli.rs / lib.rs / consts.rs / .github/workflows/release.yml) so the GUI
 * always talks to the core the same way the official CLI does.
 */

module.exports = {
  // The upstream core project — used by the "core updater" to find new
  // aether.exe builds. Change if you fork the core.
  CORE_REPO_OWNER: 'CluvexStudio',
  CORE_REPO_NAME: 'Aether',
  CORE_WINDOWS_ASSET: 'aether-windows-x86_64.zip',

  // This GUI's own repo — used by electron-updater / the "check GUI update"
  // button. Must match package.json > build.publish.
  GUI_REPO_OWNER: 'YOUR_GITHUB_USER_OR_ORG',
  GUI_REPO_NAME: 'aether-gui',

  DEFAULT_SOCKS: '127.0.0.1:1819',
  DEFAULT_HTTP_PROXY: '127.0.0.1:1820',

  // IP scanner companion tool (XIU2/CloudflareSpeedTest). This is a
  // separate, independently-updated binary — see ipScanner.js for why.
  SCANNER_REPO_OWNER: 'XIU2',
  SCANNER_REPO_NAME: 'CloudflareSpeedTest',
  SCANNER_WINDOWS_ASSET: 'cfst_windows_amd64.zip',
  SCANNER_EXE_NAME: 'cfst.exe',

  // Second connection engine (sing-box) for VLESS/VMess/Trojan/Shadowsocks
  // configs, independent of the Aether/WARP engine above. Its release
  // asset name embeds the version (e.g. sing-box-1.11.14-windows-amd64.zip)
  // so it's matched by pattern, not an exact constant.
  SINGBOX_REPO_OWNER: 'SagerNet',
  SINGBOX_REPO_NAME: 'sing-box',
  SINGBOX_WINDOWS_ASSET_PATTERN: /^sing-box-[\d.]+-windows-amd64\.zip$/,
  SINGBOX_EXE_NAME: 'sing-box.exe',
  SINGBOX_SOCKS: '127.0.0.1:2019',

  // Every environment variable the core reads, grouped the way the CLI's
  // own --help groups them. The renderer builds its form from this list,
  // and coreManager.js maps the settings object -> env vars with it.
  ENV_SCHEMA: [
    { group: 'connection', key: 'AETHER_SOCKS', type: 'text', label: 'آدرس SOCKS5 محلی', placeholder: '127.0.0.1:1819' },
    { group: 'connection', key: 'AETHER_HTTP_PROXY', type: 'text', label: 'آدرس HTTP Proxy (اختیاری)', placeholder: '127.0.0.1:1820' },
    { group: 'connection', key: 'AETHER_UPSTREAM', type: 'text', label: 'پراکسی/VPN بالادستی (اختیاری)', placeholder: 'socks5://127.0.0.1:xxxx' },
    { group: 'connection', key: 'AETHER_QUICK_RECONNECT', type: 'bool', label: 'اتصال سریع به آخرین گیت‌وی سالم', default: true },
    { group: 'connection', key: 'AETHER_IP', type: 'select', label: 'حالت IP', options: ['v4', 'v6', 'both'], default: 'v4' },
    { group: 'connection', key: 'AETHER_PEER', type: 'text', label: 'پیر اجباری MASQUE/WireGuard (اختیاری)', placeholder: 'ip:port' },
    { group: 'connection', key: 'AETHER_WG_PEER', type: 'text', label: 'پیر اجباری WireGuard بیرونی (اختیاری)', placeholder: 'ip:port' },

    { group: 'protocol', key: 'AETHER_PROTOCOL', type: 'select', label: 'پروتکل', options: ['masque', 'wg', 'gool'], default: 'masque' },
    { group: 'protocol', key: 'AETHER_SCAN', type: 'select', label: 'حالت اسکن', options: ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'], default: 'balanced' },
    { group: 'protocol', key: 'AETHER_NOIZE', type: 'select', label: 'پروفایل مبهم‌سازی (Noize)', options: ['off', 'light', 'balanced', 'aggressive'], default: 'balanced' },

    { group: 'masque', key: 'AETHER_MASQUE_HTTP2', type: 'bool', label: 'استفاده از HTTP/2 به‌جای HTTP/3', default: false },
    { group: 'masque', key: 'AETHER_MASQUE_H2_PEER', type: 'text', label: 'پیر HTTP/2 (اختیاری)' },
    { group: 'masque', key: 'AETHER_ECH', type: 'text', label: 'ECH', placeholder: 'auto یا base64' },
    { group: 'masque', key: 'AETHER_MASQUE_NO_DATA_CHECK', type: 'bool', label: 'رد شدن از بررسی data-plane', default: false },
    { group: 'masque', key: 'AETHER_MASQUE_VALIDATE_SECS', type: 'number', label: 'ثانیه‌های اعتبارسنجی', default: 10 },
    { group: 'masque', key: 'AETHER_MASQUE_STARTUP_SECS', type: 'number', label: 'مهلت راه‌اندازی MASQUE', default: 30 },
    { group: 'masque', key: 'AETHER_MASQUE_RECONNECT_SECS', type: 'number', label: 'تاخیر اتصال مجدد', default: 2 },
    { group: 'masque', key: 'AETHER_DNS', type: 'text', label: 'DNS داخل تانل', placeholder: '1.1.1.1,1.0.0.1' },
    { group: 'masque', key: 'AETHER_MASQUE_H2_FRAGMENT', type: 'bool', label: 'فرگمنت کردن TLS ClientHello (HTTP/2)', default: false },
    { group: 'masque', key: 'AETHER_MASQUE_H2_FRAGMENT_SIZE', type: 'text', label: 'اندازه فرگمنت', placeholder: '16-32' },
    { group: 'masque', key: 'AETHER_MASQUE_H2_FRAGMENT_DELAY', type: 'text', label: 'تاخیر بین فرگمنت‌ها (ms)', placeholder: '2-10' },

    { group: 'wireguard', key: 'AETHER_WG_KEEPALIVE', type: 'number', label: 'Keepalive (ثانیه)', default: 5 },
    { group: 'wireguard', key: 'AETHER_WG_NO_PROFILE_RETRY', type: 'bool', label: 'عدم تلاش مجدد با پروفایل‌های دیگر', default: false },
    { group: 'wireguard', key: 'AETHER_WG_NO_DATA_CHECK', type: 'bool', label: 'رد شدن از بررسی data-plane (WG)', default: false },
    { group: 'wireguard', key: 'AETHER_WG_VALIDATE_SECS', type: 'number', label: 'ثانیه‌های اعتبارسنجی (WG)' },
    { group: 'wireguard', key: 'AETHER_WG_RECONNECT_SECS', type: 'number', label: 'تاخیر اتصال مجدد (WG)' },

    { group: 'zerotrust', key: 'AETHER_TEAM', type: 'text', label: 'نام سازمان Zero Trust' },
    { group: 'zerotrust', key: 'AETHER_ACCESS_ID', envKey: 'AETHER_ACCESS_CLIENT_ID', type: 'text', label: 'Service Token Client ID' },
    { group: 'zerotrust', key: 'AETHER_ACCESS_SECRET', envKey: 'AETHER_ACCESS_CLIENT_SECRET', type: 'password', label: 'Service Token Client Secret' },
    { group: 'zerotrust', key: 'AETHER_ACCESS_EMAIL', type: 'text', label: 'ایمیل ورود با کد یک‌بار مصرف' },
    { group: 'zerotrust', key: 'AETHER_ACCESS_TOKEN', type: 'password', label: 'Enrolment Token (JWT)' },
    { group: 'zerotrust', key: 'AETHER_GATEWAY', type: 'bool', label: 'عبور ترافیک از Gateway سازمان', default: false },

    { group: 'routing', key: 'AETHER_ROUTE_BLOCK', type: 'textarea', label: 'مسدود شوند (هرگز خارج نروند)' },
    { group: 'routing', key: 'AETHER_ROUTE_DIRECT', type: 'textarea', label: 'مستقیم (بدون تونل)' },
    { group: 'routing', key: 'AETHER_ROUTES_FILE', type: 'file', label: 'فایل routes (اختیاری)' },

    { group: 'advanced', key: 'AETHER_CONFIG', type: 'file', label: 'فایل هویت پایه (aether.toml)' },
    { group: 'advanced', key: 'AETHER_WG_CONFIG', type: 'file', label: 'فایل هویت WireGuard' },
    { group: 'advanced', key: 'AETHER_MASQUE_CONFIG', type: 'file', label: 'فایل هویت MASQUE' },
    { group: 'advanced', key: 'AETHER_TLS_GROUPS', type: 'text', label: 'TLS key share groups', placeholder: 'P-256:X25519:P-384' },
    { group: 'advanced', key: 'AETHER_PERF_PROFILE', type: 'select', label: 'پروفایل عملکرد', options: ['', 'low', 'medium', 'high'], default: '' },
    { group: 'advanced', key: 'AETHER_LOG_LEVEL', type: 'select', label: 'سطح لاگ', options: ['error', 'warn', 'info', 'debug', 'trace'], default: 'info' }
  ]
};
