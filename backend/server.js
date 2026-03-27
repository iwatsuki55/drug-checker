import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const NORMALIZE_PROMPT = `あなたは薬剤名の正規化専門AIです。
入力された薬剤名（製品名・一般名・略称・表記揺れ混在）を正規化してください。

必ずJSON形式のみで返答してください。マークダウンや説明文は不要です。

{
  "drugs": [
    {
      "input": "入力された薬剤名（そのまま）",
      "generic_name_ja": "一般名（日本語）",
      "generic_name_en": "一般名（英語/INN）",
      "brand_examples": ["代表的な製品名1", "製品名2"],
      "drug_class": "薬効分類（例：抗凝固薬、NSAIDs）",
      "recognized": true
    }
  ],
  "unrecognized": ["認識できなかった薬剤名"]
}

ルール：
- 製品名から一般名に変換する（例：バイアスピリン→アスピリン、ワーファリン→ワルファリン）
- 表記揺れを統一する（例：アスピリン/アスピリン/aspirin→アスピリン）
- 認識できない場合はunrecognizedに入れ、drugsには含めない
- recognized=trueの場合のみdrugsに含める`;

const INTERACTION_PROMPT = `あなたは薬剤師向けの薬物相互作用チェック専門AIです。
正規化済みの薬剤リストについて、相互作用を詳細に分析してください。

必ずJSON形式のみで返答してください。マークダウンや説明文は不要です。

{
  "interactions": [
    {
      "drug_a": "薬剤名A（一般名）",
      "drug_b": "薬剤名B（一般名）",
      "severity": "contraindicated",
      "mechanism": "相互作用のメカニズム（CYP酵素・タンパク結合・薬力学的等）",
      "effect": "起こりうる臨床的影響",
      "onset": "immediate|delayed|unknown",
      "management": "具体的な対処法・モニタリング方法",
      "evidence": "高|中|低",
      "references": "参考（添付文書・ガイドライン等）"
    }
  ],
  "summary": "全体的な処方評価コメント（薬剤師向け・実用的な内容）",
  "risk_level": "high|moderate|low|none",
  "recommendations": ["推奨事項1", "推奨事項2"],
  "monitoring": ["モニタリング項目1", "モニタリング項目2"]
}

severity: contraindicated=禁忌, major=重大, moderate=中程度, minor=軽微
onset: immediate=即時, delayed=遅延, unknown=不明
日本の添付文書・ガイドラインに基づいて評価する
AIによる参考情報であり最終判断は薬剤師が行う旨をsummaryに必ず含める
相互作用がない場合はinteractionsを空配列、risk_levelをnoneにする`;

app.post("/api/check", async (req, res) => {
  const { drugs } = req.body;
  if (!drugs || !Array.isArray(drugs) || drugs.length < 2) {
    return res.status(400).json({ error: "2剤以上の薬剤名が必要です" });
  }
  try {
    const normalizeRes = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: NORMALIZE_PROMPT,
      messages: [{ role: "user", content: `以下の薬剤名を正規化してください：\n${drugs.map((d,i)=>`${i+1}. ${d}`).join("\n")}` }]
    });
    const normalizeRaw = normalizeRes.content.map(c=>c.text||"").join("");
    const normalizeData = JSON.parse(normalizeRaw.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim());

    if (normalizeData.drugs.length < 2) {
      return res.status(400).json({ error: "認識できた薬剤が2剤未満です", unrecognized: normalizeData.unrecognized });
    }

    const drugList = normalizeData.drugs.map(d=>`${d.generic_name_ja}（${d.generic_name_en}）[${d.drug_class}]`).join("\n");

    const interactionRes = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2048,
      system: INTERACTION_PROMPT,
      messages: [{ role: "user", content: `以下の正規化済み薬剤リストの相互作用をチェックしてください：\n${drugList}` }]
    });
    const interactionRaw = interactionRes.content.map(c=>c.text||"").join("");
    const interactionData = JSON.parse(interactionRaw.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim());

    res.json({ normalized: normalizeData.drugs, unrecognized: normalizeData.unrecognized||[], ...interactionData });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
