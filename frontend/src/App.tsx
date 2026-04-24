// ═══════════════════════════════════════════════════════════════════════════════
//  PipelineSync — Main Application (single-file frontend)
// ═══════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback } from "react";
import { Client } from "@stomp/stompjs";
import SockJS from "sockjs-client";
import { formatDistanceToNow } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────
interface PipelineRun {
  id: number;
  repo: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  runId: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | null;
  triggeredAt: string;
  updatedAt: string;
}

interface Annotation {
  id: number;
  pipelineRunId: number;
  jobName: string;
  author: string;
  content: string;
  type: "comment" | "warning" | "error" | "info";
  resolved: boolean;
  parentId: number | null;
  createdAt: string;
}

interface GHJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: GHStep[];
}

interface GHStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

// ─── Demo / Mock data for when backend isn't running ─────────────────────────
const DEMO_REPOS = ["acme/frontend", "acme/backend", "acme/infra"];

const DEMO_RUNS: PipelineRun[] = [
  { id: 1, repo: "acme/frontend", branch: "main", commitSha: "a3f9c12", commitMessage: "feat: add dark mode toggle", author: "sarah_k", runId: "r1", status: "completed", conclusion: "success", triggeredAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date(Date.now() - 3400000).toISOString() },
  { id: 2, repo: "acme/frontend", branch: "feature/auth", commitSha: "b7e2a55", commitMessage: "fix: token refresh race condition", author: "marcos_v", runId: "r2", status: "in_progress", conclusion: null, triggeredAt: new Date(Date.now() - 600000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString() },
  { id: 3, repo: "acme/frontend", branch: "develop", commitSha: "c1d4f88", commitMessage: "chore: bump deps", author: "priya_m", runId: "r3", status: "completed", conclusion: "failure", triggeredAt: new Date(Date.now() - 7200000).toISOString(), updatedAt: new Date(Date.now() - 6800000).toISOString() },
  { id: 4, repo: "acme/backend", branch: "main", commitSha: "d9e1b33", commitMessage: "feat: rate limiting middleware", author: "sarah_k", runId: "r4", status: "completed", conclusion: "success", triggeredAt: new Date(Date.now() - 1800000).toISOString(), updatedAt: new Date(Date.now() - 1600000).toISOString() },
];

const DEMO_JOBS: Record<number, GHJob[]> = {
  1: [
    { id: 10, name: "Lint", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Setup Node", status: "completed", conclusion: "success", number: 2 }, { name: "Run ESLint", status: "completed", conclusion: "success", number: 3 }] },
    { id: 11, name: "Unit Tests", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Install deps", status: "completed", conclusion: "success", number: 2 }, { name: "Jest", status: "completed", conclusion: "success", number: 3 }] },
    { id: 12, name: "Build", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Build", status: "completed", conclusion: "success", number: 2 }, { name: "Upload artifacts", status: "completed", conclusion: "success", number: 3 }] },
    { id: 13, name: "Deploy Staging", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [{ name: "Deploy", status: "completed", conclusion: "success", number: 1 }, { name: "Smoke tests", status: "completed", conclusion: "success", number: 2 }] },
  ],
  2: [
    { id: 20, name: "Lint", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Run ESLint", status: "completed", conclusion: "success", number: 2 }] },
    { id: 21, name: "Unit Tests", status: "in_progress", conclusion: null, started_at: "", completed_at: null, steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Install deps", status: "completed", conclusion: "success", number: 2 }, { name: "Jest", status: "in_progress", conclusion: null, number: 3 }] },
    { id: 22, name: "Build", status: "queued", conclusion: null, started_at: null, completed_at: null, steps: [] },
  ],
  3: [
    { id: 30, name: "Lint", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [] },
    { id: 31, name: "Unit Tests", status: "completed", conclusion: "failure", started_at: "", completed_at: "", steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }, { name: "Jest", status: "completed", conclusion: "failure", number: 2 }] },
  ],
  4: [
    { id: 40, name: "Lint", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [] },
    { id: 41, name: "Test", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [] },
    { id: 42, name: "Build", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [] },
    { id: 43, name: "Deploy Production", status: "completed", conclusion: "success", started_at: "", completed_at: "", steps: [] },
  ],
};

const DEMO_ANNOTATIONS: Annotation[] = [
  { id: 1, pipelineRunId: 1, jobName: "Deploy Staging", author: "marcus_v", content: "Staging deploy took longer than usual — 3.2s vs avg 1.8s. Might be cold start on the new region.", type: "warning", resolved: false, parentId: null, createdAt: new Date(Date.now() - 3200000).toISOString() },
  { id: 2, pipelineRunId: 1, jobName: "Deploy Staging", author: "sarah_k", content: "Confirmed, the us-west-2 container just had a cold start. Added pre-warm step in #PR-412.", type: "comment", resolved: false, parentId: 1, createdAt: new Date(Date.now() - 3100000).toISOString() },
  { id: 3, pipelineRunId: 3, jobName: "Unit Tests", author: "priya_m", content: "Jest snapshot test failed — AuthModal snapshot outdated after my dark mode changes. Updating.", type: "error", resolved: true, parentId: null, createdAt: new Date(Date.now() - 6500000).toISOString() },
];

// ─── API helpers ──────────────────────────────────────────────────────────────
const API = "/api";
let demoMode = false;

async function safeFetch<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return res.json();
  } catch {
    demoMode = true;
    return null;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusColor(status: string, conclusion: string | null) {
  if (status === "in_progress") return "#6c63ff";
  if (status === "queued") return "#9090b0";
  if (conclusion === "success") return "#2dd4a0";
  if (conclusion === "failure") return "#ff5c6c";
  if (conclusion === "cancelled") return "#ffd166";
  return "#9090b0";
}

function statusLabel(status: string, conclusion: string | null) {
  if (status === "in_progress") return "Running";
  if (status === "queued") return "Queued";
  if (conclusion === "success") return "Passed";
  if (conclusion === "failure") return "Failed";
  if (conclusion === "cancelled") return "Cancelled";
  return status;
}

function StatusDot({ status, conclusion, size = 8 }: { status: string; conclusion: string | null; size?: number }) {
  const color = statusColor(status, conclusion);
  const pulse = status === "in_progress";
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: size + 8, height: size + 8 }}>
      {pulse && <span style={{ position: "absolute", width: size, height: size, borderRadius: "50%", background: color, opacity: 0.4, animation: "pulse 1.5s infinite" }} />}
      <span style={{ width: size, height: size, borderRadius: "50%", background: color, display: "block", flexShrink: 0 }} />
    </span>
  );
}

function StatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  const color = statusColor(status, conclusion);
  const label = statusLabel(status, conclusion);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 4, background: color + "20", border: `1px solid ${color}40`, fontSize: 11, fontWeight: 600, color, fontFamily: "var(--mono)", letterSpacing: "0.04em" }}>
      <StatusDot status={status} conclusion={conclusion} size={6} />
      {label.toUpperCase()}
    </span>
  );
}

// ─── Components ───────────────────────────────────────────────────────────────
function Sidebar({ repos, selected, onSelect, connected }: { repos: string[]; selected: string; onSelect: (r: string) => void; connected: boolean }) {
  const all = repos.length ? repos : DEMO_REPOS;
  return (
    <aside style={{ width: 220, background: "var(--bg1)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{ padding: "20px 16px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#6c63ff" strokeWidth="1.5" />
            <path d="M8 12h8M12 8v8" stroke="#6c63ff" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>PipelineSync</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: connected ? "var(--green)" : "var(--text3)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--green)" : "var(--text3)", display: "inline-block" }} />
          {connected ? "Live" : demoMode ? "Demo mode" : "Connecting..."}
        </div>
      </div>

      <div style={{ padding: "12px 8px", flex: 1, overflowY: "auto" }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", letterSpacing: "0.08em", padding: "0 8px", marginBottom: 6 }}>REPOSITORIES</div>
        {all.map(repo => (
          <button key={repo} onClick={() => onSelect(repo)}
            style={{ width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 6, background: selected === repo ? "var(--accent)15" : "transparent", border: selected === repo ? "1px solid var(--accent)40" : "1px solid transparent", color: selected === repo ? "var(--accent2)" : "var(--text2)", fontSize: 12, fontFamily: "var(--mono)", cursor: "pointer", transition: "all 0.15s", marginBottom: 2 }}>
            <div style={{ fontSize: 9, color: "var(--text3)", marginBottom: 2 }}>{repo.split("/")[0]}/</div>
            <div style={{ fontWeight: selected === repo ? 600 : 400 }}>{repo.split("/")[1]}</div>
          </button>
        ))}

        {demoMode && (
          <div style={{ margin: "16px 8px 0", padding: 8, borderRadius: 6, background: "var(--yellow)10", border: "1px solid var(--yellow)30", fontSize: 10, color: "var(--yellow)", lineHeight: 1.5 }}>
            🎭 Demo mode — backend not detected. Showing mock data.
          </div>
        )}
      </div>
    </aside>
  );
}

function RunList({ runs, selected, onSelect }: { runs: PipelineRun[]; selected: PipelineRun | null; onSelect: (r: PipelineRun) => void }) {
  return (
    <div style={{ width: 300, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 600, color: "var(--text2)", letterSpacing: "0.06em" }}>
        PIPELINE RUNS
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {runs.length === 0 && (
          <div style={{ padding: 20, color: "var(--text3)", fontSize: 12, textAlign: "center" }}>No runs found</div>
        )}
        {runs.map(run => (
          <button key={run.id} onClick={() => onSelect(run)}
            style={{ width: "100%", textAlign: "left", padding: "12px 16px", borderBottom: "1px solid var(--border)", background: selected?.id === run.id ? "var(--bg2)" : "transparent", border: "none", borderBottom: "1px solid var(--border)", borderLeft: selected?.id === run.id ? "2px solid var(--accent)" : "2px solid transparent", cursor: "pointer", transition: "all 0.1s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <StatusBadge status={run.status} conclusion={run.conclusion} />
              <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>
                {formatDistanceToNow(new Date(run.triggeredAt), { addSuffix: true })}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 3, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {run.commitMessage}
            </div>
            <div style={{ display: "flex", gap: 8, fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>
              <span style={{ color: "var(--blue)" }}>⎇ {run.branch}</span>
              <span>{run.commitSha}</span>
              <span>by {run.author}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function JobCard({ job, pipelineRunId, annotations, onAnnotate }: {
  job: GHJob;
  pipelineRunId: number;
  annotations: Annotation[];
  onAnnotate: (jobName: string, content: string, type: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const [content, setContent] = useState("");
  const [type, setType] = useState("comment");

  const jobAnnotations = annotations.filter(a => a.jobName === job.name && !a.parentId);
  const color = statusColor(job.status, job.conclusion);

  const submit = () => {
    if (!content.trim()) return;
    onAnnotate(job.name, content, type);
    setContent("");
    setShowAnnotate(false);
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderLeft: `3px solid ${color}`, borderRadius: 8, background: "var(--bg1)", marginBottom: 8, overflow: "hidden" }}>
      {/* Job header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <StatusDot status={job.status} conclusion={job.conclusion} size={9} />
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{job.name}</span>
        {jobAnnotations.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--accent2)", background: "var(--accent)20", padding: "1px 6px", borderRadius: 10, fontFamily: "var(--mono)" }}>
            {jobAnnotations.length} note{jobAnnotations.length > 1 ? "s" : ""}
          </span>
        )}
        <button onClick={e => { e.stopPropagation(); setShowAnnotate(!showAnnotate); }}
          style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "var(--bg2)", color: "var(--text2)", border: "1px solid var(--border2)", marginRight: 4 }}>
          + Annotate
        </button>
        <span style={{ color: "var(--text3)", fontSize: 12, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {/* Steps */}
          {job.steps?.length > 0 && (
            <div style={{ padding: "8px 14px", borderBottom: annotations.length > 0 || showAnnotate ? "1px solid var(--border)" : "none" }}>
              {job.steps.map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                  <StatusDot status={step.status} conclusion={step.conclusion} size={6} />
                  <span style={{ color: "var(--text2)", fontFamily: "var(--mono)" }}>{step.number}.</span>
                  <span style={{ color: step.conclusion === "failure" ? "var(--red)" : "var(--text)" }}>{step.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Annotation input */}
          {showAnnotate && (
            <div style={{ padding: 12, borderBottom: "1px solid var(--border)", background: "var(--bg2)" }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {["comment", "warning", "error", "info"].map(t => (
                  <button key={t} onClick={() => setType(t)}
                    style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid " + (type === t ? "var(--accent)" : "var(--border)"), background: type === t ? "var(--accent)20" : "var(--bg1)", color: type === t ? "var(--accent2)" : "var(--text3)", fontFamily: "var(--mono)" }}>
                    {t}
                  </button>
                ))}
              </div>
              <textarea value={content} onChange={e => setContent(e.target.value)}
                placeholder="Leave a note for your team..."
                rows={2}
                style={{ width: "100%", background: "var(--bg1)", border: "1px solid var(--border2)", borderRadius: 6, padding: "8px 10px", color: "var(--text)", fontSize: 12, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button onClick={submit}
                  style={{ padding: "5px 14px", borderRadius: 5, background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600 }}>
                  Post
                </button>
                <button onClick={() => setShowAnnotate(false)}
                  style={{ padding: "5px 10px", borderRadius: 5, background: "var(--bg1)", color: "var(--text2)", fontSize: 12, border: "1px solid var(--border)" }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Existing annotations */}
          {jobAnnotations.length > 0 && (
            <div style={{ padding: "8px 14px" }}>
              {jobAnnotations.map(ann => (
                <AnnotationThread key={ann.id} annotation={ann} all={annotations} pipelineRunId={pipelineRunId} onAnnotate={onAnnotate} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnnotationThread({ annotation, all, pipelineRunId, onAnnotate }: {
  annotation: Annotation;
  all: Annotation[];
  pipelineRunId: number;
  onAnnotate: (jobName: string, content: string, type: string, parentId?: number) => void;
}) {
  const replies = all.filter(a => a.parentId === annotation.id);
  const [showReply, setShowReply] = useState(false);
  const [reply, setReply] = useState("");

  const typeColors: Record<string, string> = { warning: "var(--yellow)", error: "var(--red)", info: "var(--blue)", comment: "var(--accent)" };
  const color = typeColors[annotation.type] || "var(--accent)";

  const submitReply = () => {
    if (!reply.trim()) return;
    onAnnotate(annotation.jobName, reply, "comment", annotation.id);
    setReply("");
    setShowReply(false);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ borderLeft: `2px solid ${color}`, paddingLeft: 10, paddingTop: 4, paddingBottom: 4, opacity: annotation.resolved ? 0.5 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{annotation.author}</span>
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: color + "20", color, fontFamily: "var(--mono)" }}>{annotation.type}</span>
          {annotation.resolved && <span style={{ fontSize: 9, color: "var(--green)" }}>✓ resolved</span>}
          <span style={{ fontSize: 10, color: "var(--text3)", marginLeft: "auto" }}>{formatDistanceToNow(new Date(annotation.createdAt), { addSuffix: true })}</span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5 }}>{annotation.content}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
          <button onClick={() => setShowReply(!showReply)}
            style={{ fontSize: 10, color: "var(--text3)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ↩ Reply
          </button>
          <button onClick={async () => {
            await safeFetch(`${API}/annotations/${annotation.id}/resolve`, { method: "PATCH" });
            window.location.reload();
          }}
            style={{ fontSize: 10, color: annotation.resolved ? "var(--text3)" : "var(--green)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {annotation.resolved ? "↺ Reopen" : "✓ Resolve"}
          </button>
        </div>
      </div>

      {replies.map(r => (
        <div key={r.id} style={{ borderLeft: "2px solid var(--border2)", marginLeft: 16, paddingLeft: 10, marginTop: 4, paddingTop: 4, paddingBottom: 4 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{r.author}</span>
            <span style={{ fontSize: 10, color: "var(--text3)" }}>{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text2)" }}>{r.content}</p>
        </div>
      ))}

      {showReply && (
        <div style={{ marginLeft: 16, marginTop: 6 }}>
          <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2}
            placeholder="Reply..."
            style={{ width: "100%", background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 5, padding: "6px 8px", color: "var(--text)", fontSize: 12, resize: "none" }} />
          <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
            <button onClick={submitReply} style={{ padding: "3px 10px", borderRadius: 4, background: "var(--accent)", color: "#fff", fontSize: 11 }}>Reply</button>
            <button onClick={() => setShowReply(false)} style={{ padding: "3px 8px", borderRadius: 4, background: "var(--bg2)", color: "var(--text2)", fontSize: 11, border: "1px solid var(--border)" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineDetail({ run, jobs, annotations, onAnnotate, onRefresh }: {
  run: PipelineRun;
  jobs: GHJob[];
  annotations: Annotation[];
  onAnnotate: (jobName: string, content: string, type: string, parentId?: number) => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
      {/* Run header */}
      <div style={{ background: "var(--bg1)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <div>
            <StatusBadge status={run.status} conclusion={run.conclusion} />
            <h2 style={{ marginTop: 8, fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{run.commitMessage}</h2>
          </div>
          <button onClick={onRefresh}
            style={{ padding: "5px 12px", borderRadius: 5, background: "var(--bg2)", color: "var(--text2)", fontSize: 11, border: "1px solid var(--border2)" }}>
            ↺ Refresh
          </button>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text3)", fontFamily: "var(--mono)", flexWrap: "wrap" }}>
          <span><span style={{ color: "var(--blue)" }}>branch</span> {run.branch}</span>
          <span><span style={{ color: "var(--blue)" }}>sha</span> {run.commitSha}</span>
          <span><span style={{ color: "var(--blue)" }}>by</span> {run.author}</span>
          <span><span style={{ color: "var(--blue)" }}>started</span> {formatDistanceToNow(new Date(run.triggeredAt), { addSuffix: true })}</span>
          <span><span style={{ color: "var(--blue)" }}>run_id</span> {run.runId.length > 12 ? run.runId.slice(0, 12) + "…" : run.runId}</span>
        </div>
      </div>

      {/* Pipeline graph */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 10 }}>PIPELINE GRAPH</div>
        <div style={{ display: "flex", gap: 0, alignItems: "center", overflowX: "auto", paddingBottom: 4 }}>
          {jobs.map((job, i) => (
            <div key={job.id} style={{ display: "flex", alignItems: "center" }}>
              <div style={{ textAlign: "center", minWidth: 80 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${statusColor(job.status, job.conclusion)}`, background: statusColor(job.status, job.conclusion) + "20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 4px" }}>
                  <StatusDot status={job.status} conclusion={job.conclusion} size={10} />
                </div>
                <div style={{ fontSize: 9, color: "var(--text2)", lineHeight: 1.3, maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.name}</div>
              </div>
              {i < jobs.length - 1 && (
                <div style={{ width: 30, height: 2, background: "var(--border2)", flexShrink: 0 }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Jobs */}
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 10 }}>JOBS & ANNOTATIONS</div>
      {jobs.map(job => (
        <JobCard key={job.id} job={job} pipelineRunId={run.id} annotations={annotations} onAnnotate={onAnnotate} />
      ))}

      {jobs.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text3)", fontSize: 12 }}>
          No jobs data available. Add GITHUB_TOKEN to backend for live job details.
        </div>
      )}
    </div>
  );
}

// ─── Collaborators presence indicator ────────────────────────────────────────
function Presence({ users }: { users: string[] }) {
  const colors = ["#6c63ff", "#2dd4a0", "#ffd166", "#ff5c6c", "#4ea8de"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {users.map((u, i) => (
        <div key={u} title={u}
          style={{ width: 26, height: 26, borderRadius: "50%", background: colors[i % colors.length], display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", border: "2px solid var(--bg)", marginLeft: i > 0 ? -6 : 0 }}>
          {u[0].toUpperCase()}
        </div>
      ))}
      {users.length > 0 && <span style={{ fontSize: 10, color: "var(--text3)", marginLeft: 4 }}>{users.length} online</span>}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [username, setUsername] = useState(() => "dev_" + Math.random().toString(36).slice(2, 5));
  const [selectedRepo, setSelectedRepo] = useState(DEMO_REPOS[0]);
  const [repos, setRepos] = useState<string[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>(DEMO_RUNS.filter(r => r.repo === DEMO_REPOS[0]));
  const [selectedRun, setSelectedRun] = useState<PipelineRun | null>(DEMO_RUNS[0]);
  const [jobs, setJobs] = useState<GHJob[]>(DEMO_JOBS[1] || []);
  const [annotations, setAnnotations] = useState<Annotation[]>(DEMO_ANNOTATIONS.filter(a => a.pipelineRunId === 1));
  const [connected, setConnected] = useState(false);
  const [onlineUsers] = useState(["sarah_k", "marcos_v", username]);
  const stompRef = useRef<Client | null>(null);

  // Load repos
  useEffect(() => {
    safeFetch<string[]>(`${API}/repos`).then(data => {
      if (data?.length) setRepos(data);
    });
  }, []);

  // Load runs for selected repo
  const loadRuns = useCallback(async () => {
    const data = await safeFetch<PipelineRun[]>(`${API}/pipelines?repo=${encodeURIComponent(selectedRepo)}`);
    if (data?.length) {
      setRuns(data);
      setSelectedRun(data[0]);
    } else {
      const demo = DEMO_RUNS.filter(r => r.repo === selectedRepo);
      setRuns(demo.length ? demo : DEMO_RUNS.slice(0, 2).map(r => ({ ...r, repo: selectedRepo })));
      setSelectedRun(demo[0] ?? DEMO_RUNS[0]);
    }
  }, [selectedRepo]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Load jobs and annotations for selected run
  const loadRunDetail = useCallback(async (run: PipelineRun) => {
    // Jobs
    const jobData = await safeFetch<{ jobs: GHJob[] }>(`${API}/github/runs/${run.runId}/jobs?repo=${encodeURIComponent(run.repo)}`);
    if (jobData?.jobs) {
      setJobs(jobData.jobs);
    } else {
      setJobs(DEMO_JOBS[run.id] || []);
    }

    // Annotations
    const annData = await safeFetch<Annotation[]>(`${API}/pipelines/${run.id}/annotations`);
    if (annData) {
      setAnnotations(annData);
    } else {
      setAnnotations(DEMO_ANNOTATIONS.filter(a => a.pipelineRunId === run.id));
    }
  }, []);

  useEffect(() => {
    if (selectedRun) loadRunDetail(selectedRun);
  }, [selectedRun, loadRunDetail]);

  // WebSocket
  useEffect(() => {
    const client = new Client({
      webSocketFactory: () => new SockJS("/ws"),
      reconnectDelay: 3000,
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });

    client.onConnect = () => {
      setConnected(true);
      const topic = "/topic/pipeline/" + selectedRepo.replace("/", "_");
      client.subscribe(topic, msg => {
        try {
          const event = JSON.parse(msg.body);
          if (event.type === "PIPELINE_UPDATE") {
            setRuns(prev => {
              const idx = prev.findIndex(r => r.id === event.payload.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = event.payload; return next; }
              return [event.payload, ...prev];
            });
          }
          if (event.type === "ANNOTATION" && selectedRun?.id === event.payload.pipelineRunId) {
            setAnnotations(prev => [...prev.filter(a => a.id !== event.payload.id), event.payload]);
          }
        } catch {}
      });
    };

    client.activate();
    stompRef.current = client;
    return () => { client.deactivate(); };
  }, [selectedRepo, selectedRun?.id]);

  // Post annotation
  const handleAnnotate = async (jobName: string, content: string, type: string, parentId?: number) => {
    if (!selectedRun) return;
    const body = { jobName, author: username, content, type, parentId: parentId ?? null };
    const saved = await safeFetch<Annotation>(`${API}/pipelines/${selectedRun.id}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (saved) {
      setAnnotations(prev => [...prev, saved]);
    } else {
      // Demo fallback
      const ann: Annotation = { id: Date.now(), pipelineRunId: selectedRun.id, jobName, author: username, content, type: type as Annotation["type"], resolved: false, parentId: parentId ?? null, createdAt: new Date().toISOString() };
      setAnnotations(prev => [...prev, ann]);
    }
  };

  return (
    <>
      <style>{`
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.4; } 50% { transform: scale(2.2); opacity: 0; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar repos={repos} selected={selectedRepo} onSelect={repo => { setSelectedRepo(repo); setSelectedRun(null); }} connected={connected} />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Top bar */}
          <header style={{ height: 48, background: "var(--bg1)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--mono)", color: "var(--accent2)" }}>{selectedRepo}</span>
              {selectedRun && <StatusBadge status={selectedRun.status} conclusion={selectedRun.conclusion} />}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Presence users={onlineUsers} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text3)" }}>
                You:
                <input value={username} onChange={e => setUsername(e.target.value)}
                  style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", color: "var(--text)", fontSize: 11, width: 90, fontFamily: "var(--mono)" }} />
              </div>
            </div>
          </header>

          {/* Main content */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            <RunList runs={runs} selected={selectedRun} onSelect={run => setSelectedRun(run)} />

            {selectedRun ? (
              <PipelineDetail
                run={selectedRun}
                jobs={jobs}
                annotations={annotations}
                onAnnotate={handleAnnotate}
                onRefresh={() => selectedRun && loadRunDetail(selectedRun)}
              />
            ) : (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: 13 }}>
                Select a pipeline run to inspect
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
