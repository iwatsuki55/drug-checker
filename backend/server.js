import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────
// エージェント① 薬剤名正規化
// 製品名・一般名・略称・表記揺れを統一する
// ─────────────────────────────────────────
const NORMALIZE_PROMPT = `あなたは薬剤・食品・サプリメントの正規化専門AIです。
入力されたアイテム（薬剤の製品名・一般名・略称、食品、サプリメント）を正規化してください。

必ずJSON形式のみで返答してください。マークダウンや説明文は不要です。

{
  "drugs": [
    {
      "input": "入力された名称（そのまま）",
      "category": "drug|food|supplement",
      "generic_name_ja": "一般名または標準名称（日本語）",
      "generic_name_en": "一般名または標準名称（英語）",
      "brand_examples": ["代表的な製品名・別名1", "別名2"],
      "drug_class": "薬効分類または種別（例：抗凝固薬、柑橘類、ビタミンK含有食品、植物性サプリ）",
      "recognized": true
    }
  ],
  "unrecognized": ["認識できなかった名称"]
}

ルール：
- 薬剤：製品名から一般名に変換する（例：バイアスピリン→アスピリン、ワーファリン→ワルファリン）
- 食品：標準的な名称に統一する（例：グレープフルーツ、納豆、牛乳、セイヨウオトギリソウ）
- サプリメント：成分名に統一する（例：St. John's Wort→セイヨウオトギリソウ、CoQ10→コエンザイムQ10）
- categoryは drug/food/supplement のいずれかを設定する
- 認識できない場合はunrecognizedに入れ、drugsには含めない
- recognized=trueの場合のみdrugsに含める`;

// ─────────────────────────────────────────
// エージェント② 相互作用チェック
// 正規化済み薬剤リストで本格チェック
// ─────────────────────────────────────────
const INTERACTION_PROMPT = `あなたは薬剤師向けの相互作用チェック専門AIです。
薬剤・食品・サプリメントのリストについて、相互作用を分析してください。

必ずJSON形式のみで返答してください。マークダウンや説明文は不要です。

{
  "interactions": [
    {
      "drug_a": "名称A（一般名・標準名）",
      "drug_b": "名称B（一般名・標準名）",
      "severity": "contraindicated",
      "mechanism": "相互作用のメカニズム（CYP酵素・タンパク結合・薬力学的・吸収阻害等）",
      "effect": "起こりうる臨床的影響",
      "onset": "immediate|delayed|unknown",
      "management": "具体的な対処法・モニタリング方法",
      "evidence": "高|中|低",
      "source": "添付文書|インタビューフォーム|ガイドライン|学術論文",
      "references": "具体的な参考情報（例：ワルファリン添付文書 2023年改訂版 相互作用の項）"
    }
  ],
  "summary": "全体的な処方評価コメント（薬剤師向け・実用的な内容）",
  "risk_level": "high|moderate|low|none",
  "recommendations": ["推奨事項1", "推奨事項2"],
  "monitoring": ["モニタリング項目1", "モニタリング項目2"]
}

【重要ルール】
- 報告する相互作用は、日本の添付文書・インタビューフォーム・公的ガイドラインに記載のあるものに限定する
- 添付文書に記載がない推測・理論的な相互作用は含めない
- 記載が不明確な場合はevidenceを「低」とし、sourceに「情報不十分」と明記する
- 食品・サプリメントの相互作用も添付文書の「相互作用」「食事・飲酒」の項に記載があるもののみ報告する
- 代表的な例：ワルファリン×納豆（ビタミンK）、カルシウム拮抗薬×グレープフルーツ（CYP3A4阻害）、テトラサイクリン×牛乳（キレート形成）等
- severity: contraindicated=禁忌, major=重大, moderate=中程度, minor=軽微
- onset: immediate=即時, delayed=遅延, unknown=不明
- AIによる参考情報であり最終判断は薬剤師・医師が添付文書を確認した上で行う旨をsummaryに必ず含める
- 相互作用がない場合はinteractionsを空配列、risk_levelをnoneにする`;

// ─────────────────────────────────────────
// APIエンドポイント
// ─────────────────────────────────────────
app.post("/api/check", async (req, res) => {
  const { drugs } = req.body;

  if (!drugs || !Array.isArray(drugs) || drugs.length < 2) {
    return res.status(400).json({ error: "2剤以上の薬剤名が必要です" });
  }

  try {
    // ── Step 1: 正規化エージェント ──
    console.log("[Agent1] 薬剤名正規化開始:", drugs);

    const normalizeRes = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: NORMALIZE_PROMPT,
      messages: [{
        role: "user",
        content: `以下の薬剤名を正規化してください：\n${drugs.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      }]
    });

    const normalizeRaw = normalizeRes.content.map(c => c.text || "").join("");
    const normalizeClean = normalizeRaw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const normalizeData = JSON.parse(normalizeClean);

    console.log("[Agent1] 正規化完了:", JSON.stringify(normalizeData, null, 2));

    if (normalizeData.drugs.length < 2) {
      return res.status(400).json({
        error: "認識できた薬剤が2剤未満です",
        unrecognized: normalizeData.unrecognized
      });
    }

    // ── Step 2: 相互作用チェックエージェント ──
    const drugList = normalizeData.drugs.map(d =>
      `${d.generic_name_ja}（${d.generic_name_en}）[${d.drug_class}]`
    ).join("\n");

    console.log("[Agent2] 相互作用チェック開始:", drugList);

    const interactionRes = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system: INTERACTION_PROMPT,
      messages: [{
        role: "user",
        content: `以下の正規化済み薬剤リストの相互作用をチェックしてください：\n${drugList}`
      }]
    });

    const interactionRaw = interactionRes.content.map(c => c.text || "").join("");
    const interactionClean = interactionRaw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const interactionData = JSON.parse(interactionClean);

    console.log("[Agent2] チェック完了: interactions:", interactionData.interactions?.length);

    // ── レスポンス ──
    res.json({
      normalized: normalizeData.drugs,
      unrecognized: normalizeData.unrecognized || [],
      ...interactionData
    });

  } catch (err) {
    console.error("[Error]", err);
    res.status(500).json({ error: err.message });
  }
});

// ヘルスチェック
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`✅ Drug Checker Backend running on http://localhost:${PORT}`);
});
