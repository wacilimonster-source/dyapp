# 附录 B · 状态数据模型与效果协议

> 把卡片 `ZOD` 脚本的 Schema 翻译成 **TypeScript 强类型**，并定义独立版的**效果（effect）落地协议**。
> 目标：**模型只写意图，引擎负责落地**；所有 0–100 数值在引擎侧 clamp，永不掉档。

---

## B.1 核心类型

```ts
/** 0–100 区间数值（引擎统一 clamp） */
export type Pct = number; // 0..100

export interface GameState {
  世界: World;
  主角: Protagonist;
  道侣: Record<string, Partner>;
  灵宠: Record<string, SpiritPet>;
  人物: Record<string, NPC>;
  机遇: Record<string, Opportunity>;   // 最多 20
  绝色榜: Record<string, Beauty>;       // 最多 20
  玉简: Record<string, Contact>;        // 历史记录最多 100
  '$器灵台词': string[];
}

export interface World {
  当前时间: string;          // 游戏内时间（现代词）
  当前地点: string;
  危机程度: string;          // 无 / 低 / 中 / 高
  遭遇冷却: number;          // 0..15
  动向: Record<string, TrendItem>;
}

export interface TrendItem {
  阶段: '起' | '承' | '转' | '合';
  类型: string;
  地点: string;
  描述: string;
}

export interface Protagonist {
  姓名: string;
  性别: string;
  容貌: string;
  身形: string;
  衣着: string;
  境界: string;              // "炼气三层（DC:3）"
  宗门: string;
  宗门贡献: number;
  所在界: '玄天界' | '仙界';
  生命: Pct; 精血: Pct; 灵力: Pct; 修为: Pct; 神识: Pct; 道心: Pct;
  神念: string;
  气运: Record<string, Luck>;
  灵根: string;
  状态: string;
  炼丹: Craft; 炼器: Craft;
  储物袋: Record<string, Item>;
  功法: Record<string, Technique>;
  器物: Record<string, Artifact>;
}

export interface Luck {
  类型: string;       // 被动 / 主动
  效果: string;
  使用状态: string;   // 常驻 / 冷却中 …
  压制状态: string;   // 正常 / 被压制
}

export interface Craft {
  阶级: string;       // 未入门 / 一阶 …
  熟练度: Pct;
  成功率: Pct;
  次数: number;
}

export interface Item { 描述: string; 数量: number; }        // 数量<=0 自动剔除

export interface Technique { 类型: string; 境界: string; 熟练度: Pct; 描述: string; }

export interface Artifact { 等级: string; 类型: string; 损耗度: Pct; 状态: string; 描述: string; }

export interface Partner {
  性别: string; 种族: string; 状态: string; 境界: string;
  亲密: Pct; 生命: Pct; 灵力: Pct; 修为: Pct; 道心: Pct;
  性格: string;    // 禁止随剧情变化
  外观: string; 身高: string; 背景: string; 神通: string;
  心声: string;    // 内心独白（做浮字演出）
}

export interface SpiritPet {
  性别: string; 种族: string; 境界: string;
  生命: Pct; 灵力: Pct; 修为: Pct; 亲密度: Pct;
  性格: string; 容貌外观: string; 神通: string; 状态: string; 心声: string;
}

export interface NPC {
  性别: string; 头衔: string; 境界: string;
  好感: Pct;
  关系阶段: string;  // 陌生 / 试探期 / 松动期 / 信任期 / 至诚羁绊
  生命: Pct; 灵力: Pct; 修为: Pct; 道心: Pct;
  性格: string; 描述: string;
}

export interface Opportunity { 难度: string; 目标: string; 机缘: string; 引言: string; }

export interface Beauty { 排名: string; 头衔: string; 仙姿: string; 群芳谱: string; }

export interface Contact {
  性别: string; 境界: string; 关系: string; 好感度: Pct;
  历史记录: Record<string, { 发送者: string; 时间: string; 内容: string }>; // 最近 100
}
```

---

## B.2 不变量与归一化（引擎保证）

| 规则 | 实现 |
|---|---|
| 所有 `Pct` 字段 ∈ [0,100] | 写入前 `clamp(0,100)`；`NaN → 默认值` |
| `遭遇冷却` ∈ [0,15] | clamp |
| `储物袋` 数量 ≤ 0 剔除 | 每次落地后 `pickBy(数量>0)` |
| `机遇` 最多 20 | 落地后 `takeRight(20)` |
| `玉简.历史记录` 最多 100 | 落地后 `takeRight(100)` |
| 英文 key 归一化 | `{type→类型, description/desc→描述, location/place→地点, stage/phase→阶段}` |
| `境界` 格式 | `"<大境界><小境界>（DC:<数值>）"`，DC 由引擎查表生成 |
| 道侣/NPC `性格` 冻结 | 首次写入后标记为 frozen，后续 effect 修改该字段被拒绝 |

---

## B.3 效果协议（Effect Protocol）

模型**不再输出 JSON Patch**，而是输出语义化 `effects[]`。引擎解析为 `EffectOp` 并落地。

```ts
export type EffectOp =
  | { op: 'set';    target: string; value: unknown }                 // 覆盖
  | { op: 'delta';  target: string; value: number }                  // 数值增减（仅 Pct/number）
  | { op: 'add';    target: string; value: unknown }                 // 新增条目（对象/数组元素）
  | { op: 'remove'; target: string };                                // 删除条目
export interface Effect extends EffectOp { reason?: string; }

export interface TurnResult {
  narrative: string;          // 正文（纯叙事，含 UI 无关的演出标记可选）
  effects: Effect[];          // 状态变更意图
  scene?: Partial<Pick<World,'当前时间'|'当前地点'|'危机程度'>> & { 天气?: string; 灵气?: string };
  choices?: string[];         // 引擎/模型推荐的行动建议（可选）
}
```

- `target` 为**扁平点路径**：`主角.灵力`、`人物.灵玥.好感`、`世界.当前地点`、`机遇.夺宝`。
- `delta` 仅用于数值字段；`set/add/remove` 用于任意。
- 引擎落地流程：`解析路径 → 存在性检查 → clamp/归一化 → 写入 → 生成 UI 事件（飘字/进度/成就）`。
- **未知路径/非法 op**：写入 `engine.log` 并可选择"回灌一次修正请求"（默认忽略并标记）。

### 示例

```json
{
  "narrative": "你凝神引气，丹田内灵力如溪流般缓缓回复……",
  "effects": [
    { "op": "delta", "target": "主角.灵力", "value": 15, "reason": "打坐回复" },
    { "op": "delta", "target": "世界.遭遇冷却", "value": -1 },
    { "op": "set", "target": "世界.当前时间", "value": "初春·午后" }
  ],
  "scene": { "当前地点": "青云宗·后山", "危机程度": "无" },
  "choices": ["继续修炼", "去坊市看看", "找师姐说话"]
}
```

---

## B.4 引擎掷骰 → 交给模型演出

引擎负责**确定性的**结果计算，把结论交给模型去"演"，而不是让模型自己算：

| 场景 | 引擎算 | 模型演 |
|---|---|---|
| DC 对拼 | 查表双方 DC、算境界差、按阶梯给压制系数、掷骰判胜负 | 描写招式的凶险、灵压的压迫、胜负过程 |
| 突破 | 成功率 = f(道心, 灵根, 丹药) → 掷骰 | 描写经脉游走、天劫、成败 |
| 修炼 | 按灵根品阶表 + 境界周期算修为增量与耗时 | 描写闭关意象 |
| 抽气运/遭遇 | 按池子与权重掷骰抽取，查世界书候选 | 把这次遭遇演绎得"合理" |
| 物品使用 | 数量增减、归零剔除 | 描写使用过程 |

---

## B.5 存档结构

```ts
export interface SaveMeta {
  id: string; name: string; createdAt: number; updatedAt: number;
  saveVersion: number;           // Schema 版本，用于迁移
  summary: string;               // 一句话进度摘要
  thumbnail?: string;            // 截图 base64
  playtimeMs: number;
}

export interface SaveData {
  meta: SaveMeta;
  state: GameState;
  turns: TurnRecord[];           // 叙事流
}

export interface TurnRecord {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  effects?: Effect[];
  scene?: TurnResult['scene'];
  createdAt: number;
}
```

**迁移**：`saveVersion` 升级时跑 `migrations[]`（按版本顺序），保证老档可读。

---

## B.6 规则表（从卡内提取，引擎常量）

```ts
export const REALM_DC: Record<string, [number, number]> = {
  凡: [0, 0],
  炼气期: [1, 10], 筑基期: [25, 34], 金丹期: [49, 58], 元婴期: [73, 82],
  化神期: [97, 106], 炼虚期: [121, 130], 合体期: [145, 154], 大乘期: [169, 178],
  渡劫期: [182, 182], 真仙境: [217, 226], 金仙境: [241, 250], 玄仙境: [265, 274],
  仙帝境: [289, 298], 半步超脱: [666, 666], 超脱境: [999, 999],
};

/** DC 差 → 压制阶梯（对应卡内「DC点数判定」） */
export const DC_TIERS = [
  { max: 2,   desc: '同层博弈，胜负看战术/法宝/临场' },
  { max: 3,   desc: '越一小境界，高阶微弱优势' },
  { max: 6,   desc: '越两小境界，压制初显' },
  { max: 9,   desc: '越三小境界，同阶绝对压制' },
  { max: 15,  desc: '越一大境界，触发精神灵压律' },
  { max: Infinity, desc: '越数个大境界，绝对压制律 + 不可逆伤害律' },
];

/** 灵根品阶修炼加成（每次修炼修为增量） */
export const ROOT_GAIN = {
  天品: { 炼气: 30, 筑基化神: 20, 炼虚大乘: 15, 真仙仙帝: 10 },
  地品: { 炼气: 26, 筑基化神: 17, 炼虚大乘: 13, 真仙仙帝: 8 },
  玄品: { 炼气: 21, 筑基化神: 14, 炼虚大乘: 10, 真仙仙帝: 7 },
  黄品: { 炼气: 16, 筑基化神: 11, 炼虚大乘: 8,  真仙仙帝: 6 },
  凡品: { 炼气: 10, 筑基化神: 7,  炼虚大乘: 5,  真仙仙帝: 3 },
};

/** 模糊感知对照（UI 默认显示） */
export const VAGUE_LEVELS = [
  { min: 80, label: '充盈/巅峰' }, { min: 30, label: '充沛/稳固' },
  { min: 20, label: '不足/虚弱' }, { min: 10, label: '枯竭/危险' },
  { min: 1,  label: '濒危/崩溃边缘' }, { min: 0, label: '归零' },
];
```

> 道心四境、突破机制、修炼耗时（基础 30 日、境界翻倍）、遭遇冷却上限 15 等常量，均从卡内条目提取后固化在引擎里（详见 `_卡资产提取/worldbook_full.json` 条目 17 / 122 / 176 / 229 / 231）。
