import express from "express";
import multer from "multer";
import { db } from "./lib.js";
import { ingest } from "./ingest.js";
import { buildStyleProfile } from "./style.js";
import { generateExam } from "./generate.js";
import { submitAttempt } from "./mark.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// TODO: replace with real auth. For now the caller passes x-user-id.
const uid = (req: any) => req.header("x-user-id") as string;
const h = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

// Upload a PQ / note / textbook / CCMAS PDF
app.post("/documents", upload.single("file"), h(async (req, res) => {
  const { courseId, kind, lecturerId, year } = req.body;
  const documentId = await ingest({
    userId: uid(req), courseId, kind, lecturerId: lecturerId || undefined, year: year ? Number(year) : undefined,
    file: req.file.buffer, storageKey: req.file.originalname, // TODO: persist to S3/R2
  });
  if (kind === "past_question") await buildStyleProfile(courseId, lecturerId || null);
  res.json({ documentId });
}));

// Generate a mock exam
app.post("/exams", h(async (req, res) => {
  const { courseId, lecturerId, difficulty, count } = req.body;
  res.json(await generateExam({ userId: uid(req), courseId, lecturerId: lecturerId ?? null, difficulty, count }));
}));

// Fetch an exam (answers withheld until you build the submit flow)
app.get("/exams/:id", h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, position, section, q_type, marks, text, options FROM exam_questions WHERE exam_id=$1 ORDER BY position`, [req.params.id]);
  res.json(rows);
}));

// Topic heat map: how often each CCMAS topic shows up in past questions
app.get("/courses/:id/heatmap", h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.title, count(q.id)::int AS questions FROM ccmas_topics t
     LEFT JOIN pq_questions q ON q.topic_id=t.id WHERE t.course_id=$1 GROUP BY t.id ORDER BY questions DESC`, [req.params.id]);
  res.json(rows);
}));

// Submit answers: MCQs marked directly, written answers marked by the LLM against the model answer
app.post("/exams/:id/submit", h(async (req, res) => {
  res.json(await submitAttempt(uid(req), req.params.id, req.body.answers ?? []));
}));

app.get("/courses", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, code, title FROM courses ORDER BY code`)).rows);
}));
app.get("/lecturers", h(async (_req, res) => {
  res.json((await db.query(`SELECT id, name FROM lecturers ORDER BY name`)).rows);
}));

app.listen(3000, () => console.log("PQ prep API on :3000"));
