import io

NL = chr(10)


def edit(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new, why in pairs:
        assert old in s, 'NOT MATCHED in %s: %s' % (path, why)
        s = s.replace(old, new, 1)
        print('  ok', why)
    io.open(path, 'w', encoding='utf-8', newline=NL).write(s)


# ============ R8: sanitize_id 不再是"所有中文名塌缩到 save" ============
edit('app/src-tauri/src/paths.rs', [
    ("""/// 存档 id 只允许字母数字与 `-` `_`，防止 `../` 逃逸出存档目录。
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "save".to_string()
    } else {
        cleaned
    }
}""",
     """/// 存档 / 预设 id 只允许字母数字与 `-` `_`，防止 `../` 逃逸出配置目录。
///
/// 实测坑：中文名（如"默认预设"）会被过滤成空串。原先一律回退到常量 `"save"`，
/// 于是**所有中文名都塌缩成同一个 id**——第二份中文存档/预设会互相撞名。
/// 现在改成附带一个确定性短哈希，既不碰撞也不引入随机性。
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if !cleaned.is_empty() {
        return cleaned;
    }
    if id.trim().is_empty() {
        return "save".to_string();
    }
    // FNV-1a：快、无依赖、同输入同结果
    let mut h: u32 = 0x811c_9dc5;
    for b in id.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("id-{h:08x}")
}""",
     'sanitize_id 加确定性哈希'),
])

# ============ R4: crypto 统一按 MAGIC 分派，让跨平台提示可达 + 校验密钥文件长度 ============
edit('app/src-tauri/src/crypto.rs', [
    ("""/// 密文格式版本。
const MAGIC: &[u8; 4] = b"DYA1";""",
     """/// Windows DPAPI 密文头。
const MAGIC_DPAPI: &[u8; 4] = b"DYA1";""",
     'MAGIC_DPAPI'),
    ("""/// 密文格式版本。
const MAGIC: &[u8; 4] = b"DYA2";""",
     """/// AEAD 密文头（非 Windows 平台）。
const MAGIC_AEAD: &[u8; 4] = b"DYA2";""",
     'MAGIC_AEAD'),
    ("""pub fn open(config_dir: &Path, blob: &[u8]) -> AppResult<Vec<u8>> {
    if blob.len() < 5 || &blob[..4] != MAGIC {
        return Err(AppError::Data("密钥文件格式不对或已损坏".into()));
    }
    match blob[4] {
        1 => {
            #[cfg(windows)]
            {
                platform_open(blob)
            }
            #[cfg(not(windows))]
            {
                Err(AppError::Data(
                    "该密钥文件由 Windows 的 DPAPI 加密，无法在本平台解开；请在本机重新填写一次。".into(),
                ))
            }
        }
        2 => aead_open(config_dir, blob),
        v => Err(AppError::Data(format!("不认识的密钥文件版本：{v}"))),
    }
}""",
     """/// 解密。**按密文头分派**，而不是按平台各自的 MAGIC ——
/// 原先 MAGIC 是平台相关的（Windows 写 DYA1、其它写 DYA2），于是安卓上一看到
/// Windows 的密文就报"格式不对"，那句"这是 DPAPI 加密、请在本机重填"的提示
/// 永远走不到。现在两个头都认，跨设备拷贝能给出可读解释。
pub fn open(config_dir: &Path, blob: &[u8]) -> AppResult<Vec<u8>> {
    if blob.len() < 5 {
        return Err(AppError::Data("密钥文件格式不对或已损坏".into()));
    }
    match &blob[..4] {
        h if h == MAGIC_DPAPI => platform_open(blob),
        h if h == MAGIC_AEAD => aead_open(config_dir, blob),
        _ => Err(AppError::Data("密钥文件格式不对或已损坏".into())),
    }
}""",
     'open 按密文头分派'),
    ("""pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > 4 && &blob[..4] == MAGIC
}""",
     """pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > 4 && (&blob[..4] == MAGIC_DPAPI || &blob[..4] == MAGIC_AEAD)
}""",
     'is_sealed 认两种头'),
    ("""        Ok([MAGIC.as_slice(), &[1u8], &out].concat())""",
     """        Ok([MAGIC_DPAPI.as_slice(), &[1u8], &out].concat())""",
     'platform_seal 用 MAGIC_DPAPI'),
    ("""    Ok([MAGIC.as_slice(), &[2u8], &nonce_bytes, &ct].concat())""",
     """    Ok([MAGIC_AEAD.as_slice(), &[2u8], &nonce_bytes, &ct].concat())""",
     'aead_seal 用 MAGIC_AEAD'),
    ("""    let salt_path = config_dir.join(SALT_FILE);""",
     """    // 长度校验：被截断的密钥/盐会让 HKDF 照常派生出"解不开的"密钥，
    // 报错信息会指向"文件损坏"，与真实原因（长度不对）不符，排查时会跑偏。
    if master.len() != 32 {
        return Err(AppError::Data(format!(
            "密钥文件 {KEY_FILE} 长度异常（{} 字节，应为 32），请删除后重新填写 API Key",
            master.len()
        )));
    }

    let salt_path = config_dir.join(SALT_FILE);""",
     '主密钥长度校验'),
    ("""    let hk = Hkdf::<Sha256>::new(Some(&salt), &master);""",
     """    if salt.len() != 16 {
        return Err(AppError::Data(format!(
            "盐文件 {SALT_FILE} 长度异常（{} 字节，应为 16）",
            salt.len()
        )));
    }

    let hk = Hkdf::<Sha256>::new(Some(&salt), &master);""",
     '盐长度校验'),
])

print('Rust 第一批完成')
