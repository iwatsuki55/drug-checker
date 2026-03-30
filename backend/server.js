import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────
// エージェント① 薬剤名正規化（共通）
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
- 食品：標準的な名称に統一する（例：グレープフルーツ、納豆、牛乳）
- サプリメント：成分名に統一する（例：St. John's Wort→セイヨウオトギリソウ、CoQ10→コエンザイムQ10）
- categoryは drug/food/supplement のいずれかを設定する
- 認識できない場合はunrecognizedに入れ、drugsには含めない
- recognized=trueの場合のみdrugsに含める`;

// ─────────────────────────────────────────
// エージェント② 相互作用チェック（薬剤師向け）
// ─────────────────────────────────────────
const INTERACTION_PROMPT_PHARMACIST = `あなたは薬剤師向けの相互作用チェック専門AIです。
薬剤・食品・サプリメントのリストについて、相互作用を専門家向けに分析してください。

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
      "management": "具体的な対処法・モニタリング方法（専門家向け）",
      "evidence": "高|中|低",
      "source": "添付文書|インタビューフォーム|ガイドライン|学術論文",
      "references": "具体的な参考情報（例：ワルファリン添付文書 相互作用の項）"
    }
  ],
  "summary": "全体的な処方評価コメント（薬剤師・医師向け専門的内容）",
  "risk_level": "high|moderate|low|none",
  "recommendations": ["薬剤師・医師向けの専門的な推奨事項"],
  "monitoring": ["専門的なモニタリング項目（検査値・症状等）"]
}

【重要ルール】
- 報告する相互作用は日本の添付文書・インタビューフォーム・公的ガイドラインに記載のあるものに限定する
- 添付文書に記載がない推測・理論的な相互作用は含めない
- 記載が不明確な場合はevidenceを「低」とし、sourceに「情報不十分」と明記する
- 食品・サプリメントの相互作用も添付文書の「相互作用」「食事・飲酒」の項に記載があるもののみ報告する
- severity: contraindicated=禁忌, major=重大, moderate=中程度, minor=軽微
- onset: immediate=即時, delayed=遅延, unknown=不明
- AIによる参考情報であり最終判断は薬剤師・医師が添付文書を確認した上で行う旨をsummaryに含める
- 相互作用がない場合はinteractionsを空配列、risk_levelをnoneにする`;

// ─────────────────────────────────────────
// エージェント② 相互作用チェック（一般向け）
// ─────────────────────────────────────────
const INTERACTION_PROMPT_PUBLIC = `あなたは一般の患者・生活者向けの薬の飲み合わせ確認AIアシスタントです。
薬・食品・サプリメントのリストについて、飲み合わせを一般の人にわかりやすく説明してください。

必ずJSON形式のみで返答してください。マークダウンや説明文は不要です。

{
  "interactions": [
    {
      "drug_a": "名称A（わかりやすい名前）",
      "drug_b": "名称B（わかりやすい名前）",
      "severity": "contraindicated",
      "mechanism": "なぜ問題になるかの簡単な説明（専門用語を使わず、中学生でもわかる言葉で）",
      "effect": "体にどんな影響が出る可能性があるか（具体的な症状で）",
      "onset": "immediate|delayed|unknown",
      "management": "具体的にどうすればよいかのアドバイス（「医師・薬剤師に相談」「〇〇を避ける」等）",
      "evidence": "高|中|低",
      "source": "添付文書|インタビューフォーム|ガイドライン|学術論文",
      "references": "参考情報"
    }
  ],
  "summary": "全体的な説明（一般の人向け・やさしい言葉で・具体的な行動を含む）",
  "risk_level": "high|moderate|low|none",
  "recommendations": ["一般の人向けのわかりやすいアドバイス（具体的な行動指示）"],
  "monitoring": ["日常生活で注意すべき症状や変化（専門用語なし）"]
}

【重要ルール】
- 報告する相互作用は日本の添付文書・インタビューフォーム・公的ガイドラインに記載のあるものに限定する
- 添付文書に記載がない推測・理論的な相互作用は含めない
- 専門用語（CYP・PT-INR・血中濃度等）は使わず、日常語で説明する
- 「病院・薬局に相談する」「〇〇を食べるのを控える」など具体的な行動指示を含める
- 不安を煽りすぎず、でも必要な注意は明確に伝える
- severity: contraindicated=危険な組み合わせ, major=要注意, moderate=注意, minor=軽い注意
- onset: immediate=すぐに, delayed=時間が経ってから, unknown=不明
- AIによる参考情報であり詳細は薬剤師・医師に相談する旨をsummaryに含める
- 相互作用がない場合はinteractionsを空配列、risk_levelをnoneにする`;

// ─────────────────────────────────────────
// APIエンドポイント
// ─────────────────────────────────────────
app.post("/api/check", async (req, res) => {
  const { drugs, mode } = req.body; // mode: "pharmacist" | "public"

  if (!drugs || !Array.isArray(drugs) || drugs.length < 2) {
    return res.status(400).json({ error: "2剤以上の薬剤名が必要です" });
  }

  const interactionPrompt = mode === "public"
    ? INTERACTION_PROMPT_PUBLIC
    : INTERACTION_PROMPT_PHARMACIST;

  try {
    // ── Step 1: 正規化エージェント ──
    console.log("[Agent1] 正規化開始:", drugs, "mode:", mode);

    const normalizeRes = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: NORMALIZE_PROMPT,
      messages: [{
        role: "user",
        content: `以下を正規化してください：\n${drugs.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      }]
    });

    const normalizeRaw = normalizeRes.content.map(c => c.text || "").join("");
    const normalizeData = JSON.parse(normalizeRaw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    console.log("[Agent1] 正規化完了:", normalizeData.drugs.length, "件");

    if (normalizeData.drugs.length < 2) {
      return res.status(400).json({
        error: "認識できた項目が2件未満です",
        unrecognized: normalizeData.unrecognized
      });
    }

    // ── Step 2: 相互作用チェックエージェント ──
    const drugList = normalizeData.drugs.map(d =>
      `${d.generic_name_ja}（${d.generic_name_en}）[${d.drug_class}]`
    ).join("\n");

    console.log("[Agent2] 相互作用チェック開始 mode:", mode);

    const interactionRes = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      system: interactionPrompt,
      messages: [{
        role: "user",
        content: `以下の飲み合わせをチェックしてください：\n${drugList}`
      }]
    });

    const interactionRaw = interactionRes.content.map(c => c.text || "").join("");
    const interactionData = JSON.parse(interactionRaw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    console.log("[Agent2] チェック完了:", interactionData.interactions?.length, "件");

    res.json({
      normalized: normalizeData.drugs,
      unrecognized: normalizeData.unrecognized || [],
      mode: mode || "pharmacist",
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
