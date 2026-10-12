import io

NL = chr(10)
P = 'app/src-tauri/src/crypto.rs'
s = io.open(P, encoding='utf-8').read()


def sub(old, new, why):
    global s
    assert old in s, 'NOT MATCHED: ' + why
    s = s.replace(old, new, 1)
    print('  ok', why)


# 1) 两个平台各自的 MAGIC → 两个"算法头"，不再与平台绑定
sub("""#[cfg(windows)]
const MAGIC: &[u8; 4] = b"DYA1";
#[cfg(not(windows))]
const MAGIC: &[u8; 4] = b"DYA2";""",
"""/// Windows DPAPI 密文头（第 5 字节为版本 = 1）。
const MAGIC_DPAPI: &[u8; 4] = b"DYA1";
/// AEAD 密文头（非 Windows 平台写，第 5 字节为版本 = 2）。
const MAGIC_AEAD: &[u8; 4] = b"DYA2";""",
    '拆成两个算法头')

# 2) open 按头分派
sub("""pub fn open(config_dir: &Path, blob: &[u8]) -> AppResult<Vec<u8>> {
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
"""/// 解密。**按密文头分派**，而不是按"本平台的 MAGIC" ——
/// 原先 MAGIC 是平台相关的（Windows 写 DYA1、其它写 DYA2），于是安卓上一看到
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
}""",
    'open 按头分派')

sub("""pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > 4 && &blob[..4] == MAGIC
}""",
"""pub fn is_sealed(blob: &[u8]) -> bool {
    blob.len() > 4 && (&blob[..4] == MAGIC_DPAPI || &blob[..4] == MAGIC_AEAD)
}""",
    'is_sealed 认两种头')

sub("""        Ok([MAGIC.as_slice(), &[1u8], &out].concat())""",
    """        Ok([MAGIC_DPAPI.as_slice(), &[1u8], &out].concat())""",
    'DPAPI 写 DYA1')

sub("""    Ok([MAGIC.as_slice(), &[2u8], &nonce_bytes, &ct].concat())""",
    """    Ok([MAGIC_AEAD.as_slice(), &[2u8], &nonce_bytes, &ct].concat())""",
    'AEAD 写 DYA2')

# 3) 密钥/盐长度校验
sub("""    let salt_path = config_dir.join(SALT_FILE);""",
"""    // 长度校验：被截断的密钥/盐会让 HKDF 照常派生出一个"解不开的"密钥，
    // 报错会指向"文件损坏"，与真实原因（长度不对）不符，排查时容易跑偏。
    if master.len() != 32 {
        return Err(AppError::Data(format!(
            "密钥文件 {KEY_FILE} 长度异常（{} 字节，应为 32）：请删除该文件后重新填写 API Key",
            master.len()
        )));
    }

    let salt_path = config_dir.join(SALT_FILE);""",
    '主密钥长度校验')

sub("""    let hk = Hkdf::<Sha256>::new(Some(&salt), &master);""",
"""    if salt.len() != 16 {
        return Err(AppError::Data(format!(
            "盐文件 {SALT_FILE} 长度异常（{} 字节，应为 16）",
            salt.len()
        )));
    }

    let hk = Hkdf::<Sha256>::new(Some(&salt), &master);""",
    '盐长度校验')

io.open(P, 'w', encoding='utf-8', newline=NL).write(s)
print('crypto.rs 修复完成')
