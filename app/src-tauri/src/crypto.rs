//! 本地密钥的静态加密。
//!
//! 威胁模型（**不吹牛**）：
//!   - 防住：磁盘/备份里出现明文 Key；有人拷走配置文件就能用；随手把配置发出去。
//!   - 防不住：攻击者能以**你的用户身份**在本机执行代码。那种情况下任何本地加密都能被解密，
//!     这不是本模块的缺陷，而是本地存储的固有限制（要更强就得走服务端）。
//!
//! 两条实现路径：
//!   - **Windows**：DPAPI（`CryptProtectData`）。密钥材料由**当前登录凭据**派生，磁盘上
//!     不存在任何可窃取的密钥文件——拷到别的机器/别的账户都解不开。
//!   - **Android / 其它**：ChaCha20-Poly1305 + HKDF-SHA256。随机主密钥单独存一个文件、
//!     与密文分离，盐值再加一层。AEAD 保证**改一个字节就解不开**（可检测篡改）。
//!     下一步应接 Android Keystore（硬件保护），见 docs/03。
//!
//! 无论哪条路径，密文都带版本头，便于日后换算法时平滑迁移。

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::paths::{read_to_string, write_atomic};

/// Windows DPAPI 密文头（第 5 字节 = 版本 1）。
const MAGIC_DPAPI: &[u8; 4] = b"DYA1";
/// AEAD 密文头（非 Windows 平台写，第 5 字节 = 版本 2）。
const MAGIC_AEAD: &[u8; 4] = b"DYA2";

const SALT_FILE: &str = "install.salt";
const KEY_FILE: &str = "install.key";

/* ============================ 对外接口 ============================ */

/// 加密。
///
/// **注意分派方式**：非 Windows 平台直接走 AEAD，不能写成"先试 DPAPI 再兜底"
/// ——那样在安卓/Linux 上 `platform_seal` 恒返回 Err，AEAD 兜底又只在 Windows 分支里编译，
/// 结果就是密钥功能在安卓上彻底不可用（这个 bug 是 CI 的 Linux 任务抓出来的）。
pub fn seal(config_dir: &Path, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    #[cfg(windows)]
    {
        platform_seal(plaintext).or_else(|dpapi_err| {
            // DPAPI 极其罕见地失败时退回 AEAD，保证功能可用，但要留痕
            eprintln!("[crypto] DPAPI 不可用，退回 AEAD：{dpapi_err}");
            aead_seal(config_dir, plaintext)
        })
    }
    #[cfg(not(windows))]
    {
        aead_seal(config_dir, plaintext)
    }
}

/// 解密。按密文里的版本头选择算法。
/// 解密。**按密文头分派**，而不是按"本平台的 MAGIC" ——
/// 原先 MAGIC 与平台绑定（Windows 写 DYA1、其它写 DYA2），于是安卓上一看到
/// Windows 的密文就先报"格式不对"，那句"这是 DPAPI 加密、请在本机重填"的提示
/// 永远走不到（死代码）。现在两个头都认，跨设备拷贝能给出可读解释。
pub fn open(config_dir: &Path, blob: &[u8]) -> AppResult<Vec<u8>> {
    if blob.len() < 5 {
        return Err(AppError::Data("密钥文件格式不对或已损坏".into()));
    }
    match &blob[..4] {
        h if h == MAGIC_DPAPI => platform_open(blob),
        h if h == MAGIC_AEAD => aead_open(config_dir, blob),
        _ => Err(AppError::Data("密钥文件格式不对或已损坏".into())),
    }
}

pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > 4 && (&blob[..4] == MAGIC_DPAPI || &blob[..4] == MAGIC_AEAD)
}

/* ============================ Windows: DPAPI ============================ */

#[cfg(windows)]
fn platform_seal(plaintext: &[u8]) -> AppResult<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // 不加密 UI 提示，只做数据保护；CRYPTPROTECT_UI_FORBIDDEN 防止弹窗卡住后台
        let ok = CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0x1, // CRYPTPROTECT_UI_FORBIDDEN
            &mut output,
        );
        if ok == 0 {
            return Err(AppError::Other("DPAPI 加密失败".into()));
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        windows_sys::Win32::Foundation::LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok([MAGIC_DPAPI.as_slice(), &[1u8], &out].concat())
    }
}

#[cfg(windows)]
fn platform_open(blob: &[u8]) -> AppResult<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let body = &blob[5..];
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: body.len() as u32,
            pbData: body.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0x1,
            &mut output,
        );
        if ok == 0 {
            return Err(AppError::Data(
                "解密失败：密钥可能是在另一个 Windows 账户 / 另一台机器上加密的".into(),
            ));
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        windows_sys::Win32::Foundation::LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(out)
    }
}

/* ============================ 其它平台: AEAD ============================ */

/// 非 Windows 平台遇到 DPAPI 密文时的解释。
///
/// 这个占位函数是**必须的**，不是凑数：`open()` 现在按密文头分派，两个头都认，
/// 于是非 Windows 上也会调到 `platform_open`。少了它，Linux/Android 直接编译不过
/// ——`cargo check` 在 Windows 上一直是绿的，是 CI 的 Linux 任务先报了 E0425。
#[cfg(not(windows))]
fn platform_open(_blob: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::Data(
        "这是 Windows（DPAPI）加密的密钥文件，本机无法解开；请在本机的「模型配置」里重新填一次 API Key"
            .into(),
    ))
}

/// 派生密钥：HKDF-SHA256(ikm = 随机主密钥, salt = install.salt, info = 用途串)。
fn derive_key(config_dir: &Path) -> AppResult<[u8; 32]> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let key_path = config_dir.join(KEY_FILE);
    let master = if key_path.exists() {
        std::fs::read(&key_path)?
    } else {
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).map_err(|e| AppError::Other(format!("随机源不可用：{e}")))?;
        write_atomic(&key_path, &k)?;
        restrict(&key_path);
        k.to_vec()
    };

    // 长度校验：被截断的密钥/盐会让 HKDF 照常派生出一个"解不开的"密钥，
    // 报错会指向"文件损坏"，与真实原因（长度不对）不符，排查时容易跑偏。
    if master.len() != 32 {
        return Err(AppError::Data(format!(
            "密钥文件 {KEY_FILE} 长度异常（{} 字节，应为 32）：请删除该文件后重新填写 API Key",
            master.len()
        )));
    }

    let salt_path = config_dir.join(SALT_FILE);
    let salt = if salt_path.exists() {
        std::fs::read(&salt_path)?
    } else {
        let mut s = [0u8; 16];
        getrandom::getrandom(&mut s).map_err(|e| AppError::Other(format!("随机源不可用：{e}")))?;
        write_atomic(&salt_path, &s)?;
        s.to_vec()
    };

    if salt.len() != 16 {
        return Err(AppError::Data(format!(
            "盐文件 {SALT_FILE} 长度异常（{} 字节，应为 16）",
            salt.len()
        )));
    }

    let hk = Hkdf::<Sha256>::new(Some(&salt), &master);
    let mut okm = [0u8; 32];
    hk.expand(b"dyapp/secrets/v1", &mut okm)
        .map_err(|_| AppError::Other("密钥派生失败".into()))?;
    Ok(okm)
}

fn aead_seal(config_dir: &Path, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Nonce};

    let key = derive_key(config_dir)?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| AppError::Other(format!("随机源不可用：{e}")))?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| AppError::Other("加密失败".into()))?;
    Ok([MAGIC_AEAD.as_slice(), &[2u8], &nonce_bytes, &ct].concat())
}

fn aead_open(config_dir: &Path, blob: &[u8]) -> AppResult<Vec<u8>> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Nonce};

    if blob.len() < 5 + 12 {
        return Err(AppError::Data("密钥文件被截断".into()));
    }
    let key = derive_key(config_dir)?;
    let nonce = &blob[5..17];
    let ct = &blob[17..];
    let cipher = ChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| AppError::Data("解密失败：密钥文件被改动过，或换过设备".into()))
}

fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    let _ = path;
}

/* ============================ 工具 ============================ */

/// 读取已加密文件；文件不存在返回 None。
pub fn read_sealed(config_dir: &Path, name: &str) -> AppResult<Option<Vec<u8>>> {
    let path = config_dir.join(name);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read(&path)?;
    if is_sealed(&raw) {
        return open(config_dir, &raw).map(Some);
    }
    // 历史遗留的明文文件：交给迁移逻辑处理，这里不静默当密文
    Err(AppError::Data(format!(
        "{name} 不是加密格式（可能是旧版本遗留的明文文件），需要迁移"
    )))
}

/// 覆盖写入加密文件。
pub fn write_sealed(config_dir: &Path, name: &str, plaintext: &[u8]) -> AppResult<()> {
    let sealed = seal(config_dir, plaintext)?;
    write_atomic(&config_dir.join(name), &sealed)?;
    Ok(())
}

/// 明文是否为"看起来像 JSON"（迁移时用来判断旧文件是否可用）。
pub fn looks_like_json(bytes: &[u8]) -> bool {
    let s = String::from_utf8_lossy(bytes);
    let t = s.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

/// 尽力清除内存中的明文（不是安全保证，只是减少残留窗口）。
pub fn wipe(buf: &mut Vec<u8>) {
    for b in buf.iter_mut() {
        *b = 0;
    }
    buf.clear();
}

/// 读取旧明文文件的内容（仅用于迁移一次性使用）。
pub fn read_legacy_plaintext(config_dir: &Path, name: &str) -> Option<String> {
    let path = config_dir.join(name);
    if !path.exists() {
        return None;
    }
    read_to_string(&path).ok().filter(|s| !s.trim().is_empty())
}

/* ============================ 测试 ============================ */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dyapp-crypto-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 加密后读回内容一致() {
        let dir = tmp_dir("roundtrip");
        let plain = br#"{"llm_api_key":"sk-test-1234567890","sync_token":"ghp_abcdefghij"}"#;
        let sealed = seal(&dir, plain).unwrap();
        assert!(is_sealed(&sealed), "输出应带格式头");
        assert!(
            !sealed.windows(12).any(|w| w == b"sk-test-1234"),
            "密文里不允许出现明文片段"
        );
        let back = open(&dir, &sealed).unwrap();
        assert_eq!(back, plain);
    }

    /// 非 Windows 上遇到 DPAPI 密文：要给出可读解释，而不是编译不过或崩掉。
    /// 这条测试**只在 CI 的 Linux 任务上真正执行**——它守的是 `open()` 按密文头分派之后，
    /// 非 Windows 侧必须存在 `platform_open` 这件事（缺了它 Linux 直接 E0425）。
    #[cfg(not(windows))]
    #[test]
    fn 非_windows_遇到_dpapi_密文给出可读报错() {
        let dir = tmp_dir("dpapi-on-unix");
        let blob = [b"DYA1".as_slice(), &[1u8], &[0u8; 32]].concat();
        assert!(is_sealed(&blob));
        let err = open(&dir, &blob).unwrap_err().to_string();
        assert!(
            err.contains("Windows"),
            "报错要说清是 Windows 的密文：{err}"
        );
    }

    #[test]
    fn 改动一个字节就解不开() {
        let dir = tmp_dir("tamper");
        let mut sealed = seal(&dir, b"hello-secret").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(open(&dir, &sealed).is_err(), "篡改必须被检测到");
    }

    /// 直接压 AEAD 路径：这样非 Windows 平台的存储逻辑在 Windows 开发机上也能被验证。
    #[test]
    fn aead_路径往返且能检测篡改() {
        let dir = tmp_dir("aead");
        let plain = br#"{"llm_api_key":"sk-aead-1234567890"}"#;
        let sealed = aead_seal(&dir, plain).unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(&sealed[4], &2u8, "版本头应为 2（AEAD）");
        assert_eq!(aead_open(&dir, &sealed).unwrap(), plain);

        let mut bad = sealed.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        assert!(aead_open(&dir, &bad).is_err(), "AEAD 必须能检测篡改");

        // 换一个目录（等价于"换了设备"）：主密钥不同，必须解不开
        let other = tmp_dir("aead-other");
        assert!(aead_open(&other, &sealed).is_err(), "换设备后不应能解开");
    }

    #[test]
    fn 非加密格式被拒绝() {
        let dir = tmp_dir("plain");
        assert!(!is_sealed(b"{\"llm_api_key\":\"x\"}"));
        assert!(open(&dir, b"{\"a\":1}").is_err());
    }

    #[test]
    fn 文件级读写往返() {
        let dir = tmp_dir("file");
        write_sealed(&dir, "probe.enc", b"{\"k\":1}").unwrap();
        let got = read_sealed(&dir, "probe.enc").unwrap().unwrap();
        assert_eq!(got, b"{\"k\":1}");
        assert!(read_sealed(&dir, "missing.enc").unwrap().is_none());
    }

    /// 回归：截断的 install.key 曾让 HKDF 照常派生出一个"解不开的"密钥，
    /// 报错指向"文件损坏"而不是真实原因（长度不对）。
    #[test]
    fn 密钥文件长度异常要明确报错() {
        let dir = tmp_dir("badkey");
        std::fs::write(dir.join(KEY_FILE), b"short").unwrap();
        let e = aead_seal(&dir, b"x").unwrap_err().to_string();
        assert!(e.contains("长度异常"), "错误信息应直指长度：{e}");
    }

    #[test]
    fn 盐文件长度异常要明确报错() {
        let dir = tmp_dir("badsalt");
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).unwrap();
        std::fs::write(dir.join(KEY_FILE), k).unwrap();
        std::fs::write(dir.join(SALT_FILE), b"123").unwrap();
        let e = aead_seal(&dir, b"x").unwrap_err().to_string();
        assert!(e.contains("长度异常"), "错误信息应直指长度：{e}");
    }

    /// 回归：MAGIC 曾与平台绑定，导致安卓上看到 Windows 密文只会报"格式不对"，
    /// "这是 DPAPI 加密"的提示不可达。现在两个头都认。
    #[test]
    fn 两种密文头都被认作已加密() {
        assert!(is_sealed(b"DYA1\x01payload"));
        assert!(is_sealed(b"DYA2\x02nonce+ciphertext"));
        assert!(!is_sealed(b"{\"a\":1}"));
    }

    #[test]
    fn 明文识别用于迁移判断() {
        assert!(looks_like_json(b"  {\"a\":1}"));
        assert!(!looks_like_json(b"not json"));
    }
}
