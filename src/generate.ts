import { db, embed, llmJson } from "./lib.js";

type Diff = "easy" | "medium" | "hard";
const DIFF: Record<Diff, string> = {
  easy: "mostly recall/definition questions; single step; plain wording",
  medium: "application questions needing 2-3 steps",
  hard: "analysis, multi-part or calculation questions; higher marks; probe topics students find tricky",
};

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  let r = Math.random() * items.reduce((s, i) => s + Number(i.weight), 0);
  for (const i of items) if ((r -= Number(i.weight)) <= 0) return i;
  return items[items.length - 1];
}

export async function generateExam(o: { userId: string; courseId: string; lecturerId: string | null; difficulty: Diff; count?: number }) {
  const { rows: [sp] } = await db.query(
    `SELECT * FROM style_profiles WHERE course_id=$1 AND lecturer_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
    [o.courseId, o.lecturerId]);
  if (!sp) throw new Error("Upload at least one past question paper first.");

  const { rows: topics } = await db.query(`SELECT id, title, weight FROM ccmas_topics WHERE course_id=$1`, [o.courseId]);
  if (!topics.length) throw new Error("No CCMAS topics for this course yet.");

  // 1. Plan: weighted topic per question
  const n = o.count ?? 10;
  const plan = Array.from({ length: n }, () => pickWeighted(topics));
  const uniq = [...new Map(plan.map((t) => [t.id, t])).values()];

  // 2. Retrieve the user's own material for each topic
  const vecs = await embed(uniq.map((t) => t.title));
  const context: Record<string, { id: string; content: string }[]> = {};
  const { rows: all } = await db.query(
    `SELECT c.id, c.content, c.embedding FROM chunks c JOIN documents d ON d.id=c.document_id
     WHERE d.user_id=$1 AND d.course_id=$2 AND d.status='ready'`, [o.userId, o.courseId]);
  const cos = (a: number[], b: number[]) => {
    let d = 0, x = 0, y = 0;
    for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; x += a[k] * a[k]; y += b[k] * b[k]; }
    return d / (Math.sqrt(x * y) || 1);
  };
  for (let i = 0; i < uniq.length; i++) {
    const v: number[] = JSON.parse(vecs[i]);
    context[uniq[i].id] = all
      .map((c) => ({ id: c.id, content: c.content, s: cos(v, c.embedding) }))
      .sort((p, q) => q.s - p.s).slice(0, 4)
      .map(({ id, content }) => ({ id, content }));
  }

  // 3. Generate in the lecturer's style, grounded in retrieved chunks
  const draft = await llmJson<any[]>(
    `You write university exam questions that mimic one lecturer's style.
STYLE PROFILE: ${JSON.stringify(sp.profile)}
DIFFICULTY (${o.difficulty}): ${DIFF[o.difficulty]}
Use only facts present in the provided source chunks. For mcq include "options" (4) and the correct option in "answer".`,
    `Write ${n} questions, one per plan entry, in this order.
PLAN: ${JSON.stringify(plan.map((t, i) => ({ i, topic_id: t.id, topic: t.title })))}
SOURCES: ${JSON.stringify(context)}
Return array of {"topic_id","q_type","marks","text","options","answer","explanation","source_chunk_ids":[ids used]}.`);

  // 4. Verification pass: is each answer supported by its cited chunks?
  const allChunks = new Map(Object.values(context).flat().map((c) => [c.id, c.content]));
  const checks = await llmJson<{ i: number; supported: boolean }[]>(
    "You are a strict exam moderator. Judge whether each answer is correct and fully supported by its source text.",
    `Return array of {"i","supported"}.\n${JSON.stringify(draft.map((q, i) => ({
      i, question: q.text, answer: q.answer, sources: (q.source_chunk_ids ?? []).map((id: string) => allChunks.get(id)).filter(Boolean) })))}`);
  const ok = new Set(checks.filter((c) => c.supported).map((c) => c.i));

  // 5. Persist
  const total = draft.reduce((s, q) => s + Number(q.marks ?? 0), 0);
  const { rows: [exam] } = await db.query(
    `INSERT INTO exams (user_id, course_id, style_profile_id, difficulty, total_marks) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [o.userId, o.courseId, sp.id, o.difficulty, total]);
  for (let i = 0; i < draft.length; i++) {
    const q = draft[i];
    await db.query(
      `INSERT INTO exam_questions (exam_id, topic_id, position, q_type, marks, difficulty, text, options, answer, explanation, source_chunk_ids, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12)`,
      [exam.id, q.topic_id, i + 1, q.q_type, q.marks, o.difficulty, q.text, q.options ? JSON.stringify(q.options) : null,
       q.answer, q.explanation, (q.source_chunk_ids ?? []).filter((id: string) => allChunks.has(id)), ok.has(i)]);
  }
  return { examId: exam.id as string, confidence: sp.confidence, unverified: draft.length - ok.size };
}
