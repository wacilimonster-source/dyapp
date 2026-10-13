//! 同步用的信封加密：存档在离开本机之前就要变成密文。
//!
//! 为什么：同步盘用的是 GitHub 仓库，而本项目仓库是**公开**的。
//! 明文推上去等于把自己的游戏进度（含模型写出的正文）公开，且删不干净（历史还在）。
//!
//! 构造：
//! - 口令 → PBKDF2-HMAC-SHA256(310_000 轮) → 32 字节密钥；
//! - 内容用 ChaCha20-Poly1305 密封，每个文件一个随机 nonce；
//! - 盐不写在每个文件里，而是随 `.keycheck` 一起放在远端（盐不是秘密，公开无妨），
//!   这样一次口令只派生一次密钥，四个文件共用；
//! - `.keycheck` 里同时封了一句固定明文，用来在真正解密前就判断"口令对不对"。

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use sha2::Sha256;

use crate::error::{AppError, AppResult};

/// 信封头（5 字节）+ nonce(12) + 密文（含 16 字节认证标签）。
const MAGIC: &[u8; 5] = b"DYENV";
const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;
/// PBKDF2 轮数：OWASP 对 PBKDF2-HMAC-SHA256 的建议量级。
const ROUNDS: u32 = 310_000;
/// `.keycheck` 里封着的固定明文；能解出它 = 口令正确。
const CHECK_TEXT: &[u8] = b"dyapp-sync-check-v1";

/// 口令 + 盐 → 密钥。
pub fn derive_key(passphrase: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    if passphrase.is_empty() {
        return Err(AppError::NotConfigured("同步口令".into()));
    }
    if salt.len() != SALT_LEN {
        return Err(AppError::Data(format!(
            "盐长度异常（{} 字节，应为 {SALT_LEN}）",
            salt.len()
        )));
    }
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, ROUNDS, &mut key);
    Ok(key)
}

fn random_bytes<const N: usize>() -> AppResult<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|e| AppError::Other(format!("随机源不可用：{e}")))?;
    Ok(b)
}

/// 密封：返回 `DYENV | nonce | 密文`。
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let nonce = random_bytes::<NONCE_LEN>()?;
    seal_with_nonce(key, &nonce, plaintext)
}

/// 内容决定的 nonce（HMAC-SHA256(key, "nonce" | 明文) 的前 12 字节）。
///
/// 为什么不用随机 nonce：同步靠"远端 blob sha 与本地一致就跳过"来避免重复上传，
/// 随机 nonce 会让同一份内容每次密文都不同，于是每次推送都写一遍全量文件
/// （GitHub 历史里全是等价副本）。确定性密封下同一内容永远得到同一密文，
/// 而 nonce 只在明文不同时才变 —— 这正是 SIV 那一类构造的做法。
pub fn seal_stable(key: &[u8; 32], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .map_err(|_| AppError::Other("密钥长度异常".into()))?;
    mac.update(b"dyapp/sync/nonce/v1");
    mac.update(plaintext);
    let tag = mac.finalize().into_bytes();
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&tag[..NONCE_LEN]);
    seal_with_nonce(key, &nonce, plaintext)
}

fn seal_with_nonce(key: &[u8; 32], nonce: &[u8], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let ct = ChaCha20Poly1305::new(key.into())
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|_| AppError::Other("加密失败".into()))?;
    Ok([MAGIC.as_slice(), nonce, &ct].concat())
}

/// 解开一个信封。认证标签不对（口令错、内容被改）会明确报错而不是吐垃圾。
pub fn open(key: &[u8; 32], blob: &[u8]) -> AppResult<Vec<u8>> {
    if !is_sealed(blob) {
        return Err(AppError::Data(
            "远端文件不是本版的加密格式（可能是旧版明文，或口令文件被换过）".into(),
        ));
    }
    let nonce = &blob[MAGIC.len()..MAGIC.len() + NONCE_LEN];
    let ct = &blob[MAGIC.len() + NONCE_LEN..];
    ChaCha20Poly1305::new(key.into())
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| AppError::Data("解密失败：口令不对，或远端内容被改动过".into()))
}

pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > MAGIC.len() + NONCE_LEN && blob.starts_with(MAGIC)
}

/// 新盐（首次同步时生成一次，之后所有设备都从远端 `.keycheck` 里读到它）。
pub fn random_salt() -> AppResult<[u8; SALT_LEN]> {
    random_bytes::<SALT_LEN>()
}

/// 用**已派生**的密钥生成 `.keycheck`：避免一次同步里重复跑 PBKDF2（31 万轮不便宜）。
pub fn make_checkfile_with(key: &[u8; 32], salt: &[u8; SALT_LEN]) -> AppResult<Vec<u8>> {
    let body = seal(key, CHECK_TEXT)?;
    Ok([&salt[..], body.as_slice()].concat())
}

/// 从 `.keycheck` 取盐（盐不保密，明文放在文件头）。
pub fn checkfile_salt(blob: &[u8]) -> AppResult<[u8; SALT_LEN]> {
    if blob.len() <= SALT_LEN {
        return Err(AppError::Data("远端校验文件不完整".into()));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&blob[..SALT_LEN]);
    Ok(salt)
}

/// 用口令解 `.keycheck`：对不上就报"口令不对"，别等到解存档才发现。
pub fn verify_checkfile(passphrase: &str, blob: &[u8]) -> AppResult<()> {
    let salt = checkfile_salt(blob)?;
    let key = derive_key(passphrase, &salt)?;
    let plain = open(&key, &blob[SALT_LEN..])?;
    if plain != CHECK_TEXT {
        return Err(AppError::Data("口令与远端存档不匹配".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密封后能原样解开() {
        let salt = [7u8; SALT_LEN];
        let key = derive_key("青石镇见雪", &salt).unwrap();
        let data = r#"{"姓名":"沈砚","境界":"炼气三层"}"#.as_bytes().to_vec();
        let blob = seal(&key, &data).unwrap();
        assert!(is_sealed(&blob));
        assert_ne!(blob, data, "密文不能等于明文");
        assert!(
            !String::from_utf8_lossy(&blob).contains("沈砚"),
            "密文里不该有明文痕迹"
        );
        assert_eq!(open(&key, &blob).unwrap(), data);
    }

    #[test]
    fn 同一个密钥两次密封结果不同() {
        let key = derive_key("p", &[1u8; SALT_LEN]).unwrap();
        let a = seal(&key, b"same").unwrap();
        let b = seal(&key, b"same").unwrap();
        assert_ne!(a, b, "nonce 必须每次随机");
        assert_eq!(open(&key, &a).unwrap(), open(&key, &b).unwrap());
    }

    #[test]
    fn 口令不对解不开且报错明确() {
        let salt = [3u8; SALT_LEN];
        let blob = seal(&derive_key("对", &salt).unwrap(), b"secret").unwrap();
        let wrong = derive_key("错", &salt).unwrap();
        let e = open(&wrong, &blob).unwrap_err().to_string();
        assert!(e.contains("口令不对"), "报错要说人话：{e}");
    }

    #[test]
    fn 改一个字节就解不开() {
        let key = derive_key("p", &[9u8; SALT_LEN]).unwrap();
        let mut blob = seal(&key, b"payload").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert!(open(&key, &blob).is_err());
    }

    #[test]
    fn 明文存档不会被当成已加密() {
        assert!(!is_sealed(b"{\"meta\":1}"));
        assert!(!is_sealed(b"DYENV"));
        let e = open(&[0u8; 32], b"{\"meta\":1}").unwrap_err().to_string();
        assert!(e.contains("不是本版的加密格式"), "要指出是旧版明文：{e}");
    }

    #[test]
    fn 校验文件能认出口令对不对() {
        let salt = random_salt().unwrap();
        let key = derive_key("同一个口令", &salt).unwrap();
        let cf = make_checkfile_with(&key, &salt).unwrap();
        assert_eq!(checkfile_salt(&cf).unwrap(), {
            let mut s = [0u8; SALT_LEN];
            s.copy_from_slice(&cf[..SALT_LEN]);
            s
        });
        assert!(verify_checkfile("同一个口令", &cf).is_ok());
        assert!(
            verify_checkfile("另一个口令", &cf).is_err(),
            "错口令必须被挡下"
        );
        assert!(
            verify_checkfile("同一个口令", &cf[..cf.len() - 3]).is_err(),
            "截断也要挡"
        );
    }

    #[test]
    fn 确定性密封让未改动的文件不重传() {
        let key = derive_key("p", &[5u8; SALT_LEN]).unwrap();
        let a = seal_stable(&key, b"unchanged").unwrap();
        let b = seal_stable(&key, b"unchanged").unwrap();
        assert_eq!(a, b, "同一份内容必须得到同一份密文，否则每次推送都会重传");
        assert_ne!(
            a,
            seal_stable(&key, b"changed").unwrap(),
            "内容变了密文就要变"
        );
        assert_eq!(open(&key, &a).unwrap(), b"unchanged");
        // 确定性密封出来的东西仍然是合法信封，随机密封也解得开
        assert!(is_sealed(&a));
        assert_eq!(open(&key, &seal(&key, b"x").unwrap()).unwrap(), b"x");
    }

    #[test]
    fn 密文走一遍_github_的_base64_传输不变形() {
        // Contents API 返回的 base64 每 60 字符插一个换行，解码前要剥掉；
        // 密文是任意字节，不像文本那样"碰巧也能过"，所以这条要钉住。
        use base64::Engine;
        let key = derive_key("p", &[11u8; SALT_LEN]).unwrap();
        let plain: Vec<u8> = vec![0u8, 0xff, 0x7f, b'\n', b'\r', 0x1b, 0x80].repeat(30);
        let sealed = seal_stable(&key, &plain).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&sealed);
        let with_breaks: String = b64
            .as_bytes()
            .chunks(60)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        let back = base64::engine::general_purpose::STANDARD
            .decode(with_breaks.replace(['\n', '\r'], ""))
            .unwrap();
        assert_eq!(back, sealed, "base64 往返后密文必须逐字节一致");
        assert_eq!(open(&key, &back).unwrap(), plain);
    }

    #[test]
    fn 空口令直接拒() {
        let e = derive_key("", &[0u8; SALT_LEN]).unwrap_err().to_string();
        assert!(e.contains("同步口令"), "报错要指明缺什么：{e}");
    }
}
