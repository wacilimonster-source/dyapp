//! 存档读写。
//!
//! 一个存档 = 四个文件（见 docs/05 第 9 节）：
//!   meta.json （小、常读）/ state.json （唯一权威状态）/ chat.jsonl （追加式叙事流）/ world.json （解锁足迹）
//! 拆开的原因：状态要频繁整体读写与同步，叙事流是追加型大文件。分开后同步只传变化的文件。
//!
//! 写入方式：**先写临时目录、再整体换盘**（见 `write_bundle`）。
//! 每个文件内部仍走 `write_atomic`，但四个文件之间的一致性由"换盘"保证 ——
//! 掉电或被后台回收只会得到"上一版"或"这一版"，不会得到半截。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::paths::{
    ensure_dir, read_to_string, sanitize_id, save_dir, save_dir_existing, saves_dir, write_atomic,
};
use crate::secrets::redact_for_transfer;

/// 当前存档结构版本，用于日后迁移。
pub const SAVE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMeta {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default = "default_version")]
    pub save_version: u32,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub playtime_ms: i64,
    /// 存档缩略图（前端生成的 SVG data URI，极小）。旧档没有则为空串。
    #[serde(default)]
    pub thumb: String,
}

fn default_version() -> u32 {
    SAVE_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBundle {
    pub meta: SaveMeta,
    #[serde(default)]
    pub state: Value,
    #[serde(default)]
    pub turns: Vec<Value>,
    #[serde(default)]
    pub world: Value,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 写入中的临时目录后缀 / 换盘时的旧目录后缀。
///
/// 用固定后缀是为了**崩溃后能被识别**：见到 `.tmp-writing` 就知道是半成品，直接丢；
/// 见到 `<id>` 不在而 `<id>.old-backup` 在，就知道崩在"换盘"中间，把旧的换回来。
pub const TMP_SUFFIX: &str = ".tmp-writing";
pub const OLD_SUFFIX: &str = ".old-backup";

/// 这个名字看起来是不是一个存档目录（排除写入中/换盘中的残骸）。
pub fn is_save_dir_name(name: &str) -> bool {
    !name.ends_with(TMP_SUFFIX) && !name.ends_with(OLD_SUFFIX)
}

fn sibling(dir: &Path, suffix: &str) -> std::path::PathBuf {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    dir.with_file_name(format!("{name}{suffix}"))
}

/// 崩溃恢复：收拾残留的临时/旧目录，保证 `<id>` 是完整的一份。
/// （同步的推/拉路径也要先跑一次，否则可能读到换盘残骸或在 stage 时误删可恢复的旧档。）
pub(crate) fn heal_save_dir(dir: &Path) {
    let tmp = sibling(dir, TMP_SUFFIX);
    let old = sibling(dir, OLD_SUFFIX);
    let _ = std::fs::remove_dir_all(&tmp); // 临时目录必然是半成品
    if !dir.exists() && old.exists() {
        // 崩在"旧→backup"之后、"临时→正式"之前：把旧的换回来。
        // 宁可退回上一版，也不能让存档目录消失。
        if let Err(e) = std::fs::rename(&old, dir) {
            eprintln!("[save] 恢复旧存档失败：{e}");
        } else {
            eprintln!("[save] 检测到中断的写入，已回滚到上一版：{}", dir.display());
        }
    } else if dir.exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
}

fn meta_path(dir: &Path) -> std::path::PathBuf {
    dir.join("meta.json")
}
fn state_path(dir: &Path) -> std::path::PathBuf {
    dir.join("state.json")
}
fn chat_path(dir: &Path) -> std::path::PathBuf {
    dir.join("chat.jsonl")
}
fn world_path(dir: &Path) -> std::path::PathBuf {
    dir.join("world.json")
}

/* ============================ 读 ============================ */

/// 读单个存档。缺文件按空处理（刚建的档还没有 chat.jsonl 是正常的）。
pub fn read_bundle(app: &AppHandle, save_id: &str) -> AppResult<SaveBundle> {
    let id = sanitize_id(save_id);
    let dir = save_dir_existing(app, &id)?; // 读路径不创建目录
    read_bundle_at(&dir, &id)
}

/// 读存档的目录版：目录由调用方给出，单测可以直接喂一个临时目录。
fn read_bundle_at(dir: &Path, id: &str) -> AppResult<SaveBundle> {
    heal_save_dir(dir); // 先把可能被中断的写入恢复好再读
    let id = id.to_string();

    let meta: SaveMeta = if meta_path(dir).exists() {
        serde_json::from_str(&read_to_string(&meta_path(dir))?)?
    } else {
        SaveMeta {
            id: id.clone(),
            name: id.clone(),
            created_at: now_ms(),
            updated_at: now_ms(),
            save_version: SAVE_VERSION,
            summary: String::new(),
            playtime_ms: 0,
            thumb: String::new(),
        }
    };

    // state.json 是权威状态：损坏必须报错，不能静默变成 null ——
    // 前端拿到空状态可能触发"重置式覆盖"，等于把损坏升级成丢档。
    let state: Value = if state_path(dir).exists() {
        serde_json::from_str(&read_to_string(&state_path(dir))?).map_err(|e| {
            AppError::Data(format!(
                "存档 {id} 的 state.json 已损坏（{e}）；请用「导入」恢复备份，不要在此档上继续游玩"
            ))
        })?
    } else {
        Value::Null
    };

    // world.json 只是解锁足迹等附属数据：坏了不阻塞读档，但要留痕
    let world: Value = if world_path(dir).exists() {
        match serde_json::from_str(&read_to_string(&world_path(dir))?) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[save] {id} 的 world.json 损坏，已按空处理：{e}");
                json!({})
            }
        }
    } else {
        json!({})
    };

    let mut turns: Vec<Value> = Vec::new();
    if chat_path(dir).exists() {
        for line in read_to_string(&chat_path(dir))?.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(t) {
                Ok(v) => turns.push(v),
                // 单行坏了不该让整个档读不出来：跳过并继续
                Err(_) => continue,
            }
        }
    }

    Ok(SaveBundle {
        meta,
        state,
        turns,
        world,
    })
}

/* ============================ 写 ============================ */

/// 写存档。`updated_at` 由本函数刷新——时间戳是冲突判定的依据，不接受前端传值。
/// 写存档。
///
/// **四个文件按"临时目录 → 整体换盘"落地**，而不是各写各的。
///
/// 原先四个文件各自原子写，进程若在中间被杀（安卓后台回收、掉电），会留下
/// "state.json 是新的、chat.jsonl 还是旧的"这种半更新；而同步的冲突判定只看
/// `meta.updatedAt`，会据此误判"本地最新"并拒绝拉取 —— 状态与叙事流就此分叉。
/// 现在要么整份换新，要么回到上一版，不存在半截。
pub fn write_bundle(app: &AppHandle, save_id: &str, bundle: SaveBundle) -> AppResult<SaveMeta> {
    let id = sanitize_id(save_id);
    let dir = save_dir(app, &id)?;
    write_bundle_at(&dir, &id, bundle)
}

/// 写存档的目录版：目录由调用方给出，单测可以直接喂一个临时目录。
fn write_bundle_at(dir: &Path, id: &str, mut bundle: SaveBundle) -> AppResult<SaveMeta> {
    let id = id.to_string();
    let dir = dir.to_path_buf();
    let now = now_ms();

    let created = if meta_path(&dir).exists() {
        serde_json::from_str::<SaveMeta>(&read_to_string(&meta_path(&dir))?)
            .map(|m| m.created_at)
            .unwrap_or(now)
    } else {
        now
    };

    // 出盘前的兜底清洗：万一状态里混进了 apiKey 之类，也不落到磁盘上（更不会被同步出去）。
    // 叙事流（turns）同样要清洗 —— 用户可能把 Key 贴进对话里被记录。
    let mut state = bundle.state;
    redact_for_transfer(&mut state);
    let mut world = bundle.world;
    redact_for_transfer(&mut world);
    let mut turns = std::mem::take(&mut bundle.turns);
    for t in turns.iter_mut() {
        redact_for_transfer(t);
    }

    let meta = SaveMeta {
        id: id.clone(),
        name: if bundle.meta.name.trim().is_empty() {
            id.clone()
        } else {
            bundle.meta.name.trim().to_string()
        },
        created_at: created,
        updated_at: now,
        save_version: SAVE_VERSION,
        summary: bundle.meta.summary,
        playtime_ms: bundle.meta.playtime_ms,
        thumb: bundle.meta.thumb.trim().to_string(),
    };

    let mut lines = String::new();
    for t in &turns {
        lines.push_str(&serde_json::to_string(t)?);
        lines.push('\n');
    }

    // 全部先写进临时目录，再整体换盘：这一步失败不会碰到正式存档
    let files: Vec<(String, Vec<u8>)> = vec![
        ("meta.json".into(), serde_json::to_vec_pretty(&meta)?),
        ("state.json".into(), serde_json::to_vec_pretty(&state)?),
        ("world.json".into(), serde_json::to_vec_pretty(&world)?),
        ("chat.jsonl".into(), lines.into_bytes()),
    ];
    stage_files(&dir, &files)?;
    commit_stage(&dir)?;
    Ok(meta)
}

/// 把一组文件写进 `<dir>.tmp-writing/`（先清掉旧残骸），返回临时目录路径。
///
/// 与 [`commit_stage`] 配对使用；`sync_pull` 复用同一机制，让拉取落盘也是**整体换盘**，
/// 不再出现"meta 已新、chat 还是旧的"的半截状态。
pub(crate) fn stage_files(dir: &Path, files: &[(String, Vec<u8>)]) -> AppResult<PathBuf> {
    let tmp = sibling(dir, TMP_SUFFIX);
    let old = sibling(dir, OLD_SUFFIX);
    let _ = std::fs::remove_dir_all(&tmp); // 上次失败的残骸
    let _ = std::fs::remove_dir_all(&old);
    ensure_dir(&tmp)?;
    for (name, bytes) in files {
        write_atomic(&tmp.join(name), bytes)?;
    }
    Ok(tmp)
}

/// 把已 stage 的临时目录整体换盘。
///
/// 两个 rename 之间是唯一的"危险窗口"，`heal_save_dir()` 能在下次启动时把它修好。
pub(crate) fn commit_stage(dir: &Path) -> AppResult<()> {
    let tmp = sibling(dir, TMP_SUFFIX);
    let old = sibling(dir, OLD_SUFFIX);
    if dir.exists() {
        std::fs::rename(dir, &old)?;
    }
    match std::fs::rename(&tmp, dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&old);
            Ok(())
        }
        Err(e) => {
            // 换盘失败要把旧的换回来，不能把存档搞没了
            if old.exists() {
                let _ = std::fs::rename(&old, dir);
            }
            let _ = std::fs::remove_dir_all(&tmp);
            Err(AppError::Io(format!("替换存档目录失败（已回滚）：{e}")))
        }
    }
}

/// 删除存档目录。不可恢复。
pub fn delete_save(app: &AppHandle, save_id: &str) -> AppResult<()> {
    let id = sanitize_id(save_id);
    let dir = save_dir_existing(app, &id)?;
    for d in [
        dir.clone(),
        sibling(&dir, TMP_SUFFIX),
        sibling(&dir, OLD_SUFFIX),
    ] {
        if d.exists() {
            std::fs::remove_dir_all(&d)?;
        }
    }
    Ok(())
}

/* ============================ 导入 / 导出 ============================ */

/// 导出为单文件 JSON 包（跨设备迁移、备份用）。
pub fn export_bundle(app: &AppHandle, save_id: &str) -> AppResult<String> {
    let bundle = read_bundle(app, save_id)?;
    let mut value = serde_json::to_value(&bundle)?;
    redact_for_transfer(&mut value);
    Ok(serde_json::to_string_pretty(&value)?)
}

/// 导入单文件 JSON 包。id 冲突时自动加后缀，绝不覆盖已有存档。
pub fn import_bundle(app: &AppHandle, bundle_json: &str) -> AppResult<SaveMeta> {
    let bundle: SaveBundle = serde_json::from_str(bundle_json)
        .map_err(|e| AppError::Data(format!("存档包格式不对：{}", e)))?;

    let raw_id = if bundle.meta.id.trim().is_empty() {
        format!("import-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
    } else {
        bundle.meta.id.clone()
    };

    // 冲突就换 id，不覆盖。
    // 注意：sanitize_id 只取前 64 字符，所以拼后缀前必须先把主干截短 ——
    // 否则主干已满 64 位时，`{raw}-2` 截断后与初始 id 完全相同，循环空转 98 次
    // 后报"同 id 存档过多"，用户永远导不进来。
    let stem = sanitize_id(&raw_id);
    let mut id = stem.clone();
    let mut n = 1;
    while save_dir(app, &id)?.join("state.json").exists() {
        n += 1;
        let short: String = stem.chars().take(56).collect();
        id = sanitize_id(&format!("{short}-{n}"));
        if n > 99 {
            return Err(AppError::Other("同 id 存档过多，换一个包再试".into()));
        }
    }

    write_bundle(app, &id, bundle)
}

/* ============================ Tauri commands ============================ */

#[tauri::command]
pub fn save_list(app: AppHandle) -> AppResult<Vec<SaveMeta>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(saves_dir(&app)?)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        // 写入中 / 换盘中的残骸不是存档
        if !is_save_dir_name(&id) {
            continue;
        }
        let dir = entry.path();
        heal_save_dir(&dir); // 顺手恢复被中断的写入
        if !state_path(&dir).exists() {
            continue; // 只有目录没有状态：视为未完成，不列出
        }
        let meta = match std::fs::read_to_string(meta_path(&dir))
            .ok()
            .and_then(|s| serde_json::from_str::<SaveMeta>(&s).ok())
        {
            Some(m) => m,
            None => SaveMeta {
                id: id.clone(),
                name: id.clone(),
                created_at: 0,
                updated_at: 0,
                save_version: SAVE_VERSION,
                summary: String::new(),
                playtime_ms: 0,
                thumb: String::new(),
            },
        };
        out.push(meta);
    }
    // 最近更新的排前面
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn save_read(app: AppHandle, save_id: String) -> AppResult<SaveBundle> {
    read_bundle(&app, &save_id)
}

#[tauri::command]
pub fn save_write(app: AppHandle, save_id: String, bundle: SaveBundle) -> AppResult<SaveMeta> {
    write_bundle(&app, &save_id, bundle)
}

#[tauri::command]
pub fn save_delete(app: AppHandle, save_id: String) -> AppResult<()> {
    delete_save(&app, &save_id)
}

#[tauri::command]
pub fn save_export(app: AppHandle, save_id: String) -> AppResult<String> {
    export_bundle(&app, &save_id)
}

#[tauri::command]
pub fn save_import(app: AppHandle, bundle_json: String) -> AppResult<SaveMeta> {
    import_bundle(&app, &bundle_json)
}

/* ============================ 测试 ============================ */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "dy-save-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn bundle(lingli: i64, turns: usize) -> SaveBundle {
        SaveBundle {
            meta: SaveMeta {
                id: "s1".into(),
                name: "测试档".into(),
                created_at: 0,
                updated_at: 0,
                save_version: SAVE_VERSION,
                summary: String::new(),
                playtime_ms: 0,
                thumb: String::new(),
            },
            state: json!({ "主角": { "灵力": lingli } }),
            turns: (0..turns)
                .map(|i| json!({ "id": i, "role": "user", "text": "hi" }))
                .collect(),
            world: json!({ "已解锁": ["x"] }),
        }
    }

    #[test]
    fn 写入中与换盘中的残骸不算存档() {
        assert!(is_save_dir_name("存档一"));
        assert!(!is_save_dir_name(&format!("存档一{TMP_SUFFIX}")));
        assert!(!is_save_dir_name(&format!("存档一{OLD_SUFFIX}")));
    }

    #[test]
    fn 写入后读回一致且不留残骸() {
        let root = tmp_root("rt");
        let dir = root.join("s1");
        let meta = write_bundle_at(&dir, "s1", bundle(42, 3)).unwrap();

        assert!(dir.join("state.json").exists());
        assert!(dir.join("chat.jsonl").exists());
        assert!(!sibling(&dir, TMP_SUFFIX).exists(), "临时目录要清干净");
        assert!(!sibling(&dir, OLD_SUFFIX).exists(), "旧目录要清干净");

        let back = read_bundle_at(&dir, "s1").unwrap();
        assert_eq!(back.state["主角"]["灵力"], 42);
        assert_eq!(back.turns.len(), 3);
        assert_eq!(back.world["已解锁"][0], "x");
        assert_eq!(back.meta.updated_at, meta.updated_at);
        assert_eq!(
            back.meta.created_at, meta.created_at,
            "created_at 跨写要保持"
        );
    }

    #[test]
    fn 写入前残留的临时目录不会干扰这次写入() {
        let root = tmp_root("leftover");
        let dir = root.join("s1");
        // 上一轮崩在写临时目录阶段
        let tmp = sibling(&dir, TMP_SUFFIX);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("state.json"), b"{ this is broken").unwrap();

        write_bundle_at(&dir, "s1", bundle(7, 1)).unwrap();
        let back = read_bundle_at(&dir, "s1").unwrap();
        assert_eq!(back.state["主角"]["灵力"], 7);
    }

    #[test]
    fn 崩在换盘中间时回滚到上一版() {
        let root = tmp_root("heal");
        let dir = root.join("s1");
        write_bundle_at(&dir, "s1", bundle(11, 1)).unwrap();

        // 模拟：旧目录已改名到 .old-backup，新目录还没就位就断电
        let old = sibling(&dir, OLD_SUFFIX);
        std::fs::rename(&dir, &old).unwrap();
        let tmp = sibling(&dir, TMP_SUFFIX);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!dir.exists());

        // 任何一次读取都会先 heal：把旧的换回来，丢掉半成品
        let back = read_bundle_at(&dir, "s1").unwrap();
        assert_eq!(back.state["主角"]["灵力"], 11, "应回到上一版而不是读空");
        assert!(dir.exists());
        assert!(!tmp.exists());
        assert!(!old.exists());
    }

    #[test]
    fn 连续写入只保留最新一版() {
        let root = tmp_root("seq");
        let dir = root.join("s1");
        write_bundle_at(&dir, "s1", bundle(1, 10)).unwrap();
        write_bundle_at(&dir, "s1", bundle(2, 1)).unwrap();
        let back = read_bundle_at(&dir, "s1").unwrap();
        assert_eq!(back.state["主角"]["灵力"], 2);
        assert_eq!(back.turns.len(), 1, "叙事流不能混进上一版的行");
    }

    /// 回归：用户把 Key 贴进对话里被记进 turns，原样写盘后会随同步推上 GitHub。
    #[test]
    fn 叙事流里的敏感字段写盘前被清洗() {
        let root = tmp_root("redact");
        let dir = root.join("s1");
        let mut b = bundle(5, 1);
        b.turns = vec![
            json!({ "role": "user", "text": "我的key是", "apiKey": "sk-live-123456" }),
            json!({ "role": "assistant", "text": "收到", "nested": { "accessToken": "ghp_x" } }),
        ];
        write_bundle_at(&dir, "s1", b).unwrap();

        let raw = std::fs::read_to_string(chat_path(&dir)).unwrap();
        assert!(!raw.contains("sk-live"), "apiKey 必须落盘前删除：{raw}");
        assert!(!raw.contains("ghp_x"), "accessToken 变体也必须删除：{raw}");
        assert!(raw.contains("我的key是"), "正文本身不能被误删");

        let back = read_bundle_at(&dir, "s1").unwrap();
        assert_eq!(back.turns.len(), 2);
    }
}
