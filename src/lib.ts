import "dotenv/config";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

// Returns pgvector-ready strings like "[0.1,0.2,...]"
export async function embed(texts: string[]): Promise<string[]> {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  const j: any = await r.json();
  if (!j.data) throw new Error("Embedding failed: " + JSON.stringify(j));
  return j.data.map((d: any) => `[${d.embedding.join(",")}]`);
}

export async function llmJson<T>(system: string, user: string): Promise<T> {
  const r = await claude.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: system + "\nReturn ONLY valid JSON, no markdown fences, no commentary.",
    messages: [{ role: "user", content: user }],
  });
  const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}
