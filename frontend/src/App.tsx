// PipelineSync — clean, intuitive CI/CD dashboard
import { useState, useEffect, useCallback, useRef } from "react";
import { Client } from "@stomp/stompjs";
// @ts-ignore
import SockJS from "sockjs-client/dist/sockjs";
import { formatDistanceToNow, format } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Run {
  id: number; run_number: number; head_branch: string; head_sha: string;
  status: string; conclusion: string | null; created_at: string;
  display_title: string;
  triggering_actor: { login: string };
  head_commit: { message: string };
}
interface Job {
  id: number; name: string; status: string; conclusion: string | null;
  steps: { name: string; status: string; conclusion: string | null; number: number }[];
}
interface Note {
  id: number; pipelineRunId: number; jobName: string; author: string;
  content: string; type: string; resolved: boolean; createdAt: string;
}

const API = "/api";
const STORAGE_KEY = "pipelinesync_repos";

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  in_progress: "#818cf8", queued: "#6b7280",
  success: "#34d399", failure: "#f87171", cancelled: "#fbbf24",
};
const getColor = (status: string, conclusion: string | null) =>
  conclusion ? (STATUS_COLOR[conclusion] || "#6b7280") : (STATUS_COLOR[status] || "#6b7280");
const getLabel = (status: string, conclusion: string | null) => {
  if (status === "in_progress") return "Running";
  if (status === "queued") return "Queued";
  if (conclusion === "success") return "Passed";
  if (conclusion === "failure") return "Failed";
  if (conclusion === "cancelled") return "Cancelled";
  return status;
};

// ─── Tiny components ──────────────────────────────────────────────────────────
const Dot = ({ status, conclusion, size = 8 }: { status: string; conclusion: string | null; size?: number }) => {
  const color = getColor(status, conclusion);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: size + 6, height: size + 6, flexShrink: 0 }}>
      {status === "in_progress" && (
        <span style={{ position: "absolute", width: size, height: size, borderRadius: "50%", background: color, opacity: 0.3, animation: "ping 1.5s cubic-bezier(0,0,.2,1) infinite" }} />
      )}
      <span style={{ width: size, height: size, borderRadius: "50%", background: color, display: "block" }} />
    </span>
  );
};

const Pill = ({ status, conclusion }: { status: string; conclusion: string | null }) => {
  const color = getColor(status, conclusion);
  const label = getLabel(status, conclusion);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 20, background: color + "18", border: `1px solid ${color}35`, fontSize: 11, fontWeight: 600, color, whiteSpace: "nowrap" }}>
      <Dot status={status} conclusion={conclusion} size={6} />
      {label}
    </span>
  );
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Repos state — persisted in localStorage
  const [repos, setRepos] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '["akshatrshah/dummy-pipeline-app"]'); }
    catch { return ["akshatrshah/dummy-pipeline-app"]; }
  });
  const [newRepo, setNewRepo] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);

  // Selection state
  const [activeRepo, setActiveRepo] = useState<string>(repos[0] || "");
  const [activeRun, setActiveRun] = useState<Run | null>(null);

  // Data state
  const [runs, setRuns] = useState<Run[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [dbRunId, setDbRunId] = useState<number | null>(null);

  // UI state
  const [username, setUsername] = useState(() => "dev_" + Math.random().toString(36).slice(2, 5));
  const [connected, setConnected] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingNote, setAddingNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState("comment");

  const NOTE_COLORS: Record<string, string> = {
    comment: "#818cf8", warning: "#fbbf24", error: "#f87171", info: "#38bdf8"
  };

  // Persist repos
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
  }, [repos]);

  // Add repo
  const addRepo = () => {
    const r = newRepo.trim().replace("https://github.com/", "");
    if (!r || !r.includes("/") || repos.includes(r)) { setNewRepo(""); setAddingRepo(false); return; }
    setRepos(prev => [...prev, r]);
    setActiveRepo(r);
    setNewRepo(""); setAddingRepo(false);
  };

  const removeRepo = (repo: string) => {
    setRepos(prev => prev.filter(r => r !== repo));
    if (activeRepo === repo) setActiveRepo(repos.find(r => r !== repo) || "");
  };

  // Fetch runs
  const fetchRuns = useCallback(async () => {
    if (!activeRepo) return;
    setRunsLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/github/runs?repo=${encodeURIComponent(activeRepo)}`);
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setRuns(data.workflow_runs || []);
    } catch (e: any) { setError(e.message); }
    finally { setRunsLoading(false); }
  }, [activeRepo]);

  useEffect(() => {
    setRuns([]); setActiveRun(null); setJobs([]); setNotes([]);
    fetchRuns();
    const t = setInterval(fetchRuns, 15000);
    return () => clearInterval(t);
  }, [fetchRuns]);

  // Fetch jobs + notes when run selected
  useEffect(() => {
    if (!activeRun || !activeRepo) return;
    setJobs([]); setNotes([]); setDbRunId(null); setJobsLoading(true);

    // Fetch jobs
    fetch(`${API}/github/runs/${activeRun.id}/jobs?repo=${encodeURIComponent(activeRepo)}`)
      .then(r => r.json()).then(d => setJobs(d.jobs || [])).catch(() => {})
      .finally(() => setJobsLoading(false));

    // Seed into DB + fetch notes
    fetch(`${API}/pipelines/simulate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: activeRepo, runId: String(activeRun.id),
        branch: activeRun.head_branch,
        message: activeRun.head_commit?.message || activeRun.display_title,
        author: activeRun.triggering_actor?.login || "unknown",
        status: activeRun.status, conclusion: activeRun.conclusion || "",
      }),
    }).then(() => fetch(`${API}/pipelines?repo=${encodeURIComponent(activeRepo)}`))
      .then(r => r.json())
      .then(dbRuns => {
        const db = dbRuns.find((r: any) => r.runId === String(activeRun.id));
        if (db) {
          setDbRunId(db.id);
          fetch(`${API}/pipelines/${db.id}/annotations`).then(r => r.json()).then(setNotes);
        }
      }).catch(() => {});
  }, [activeRun?.id, activeRepo]);

  // WebSocket
  useEffect(() => {
    if (!activeRepo) return;
    const client = new Client({
      webSocketFactory: () => new SockJS("/ws"), reconnectDelay: 3000,
      onConnect: () => {
        setConnected(true);
        client.subscribe(`/topic/pipeline/${activeRepo.replace("/", "_")}`, msg => {
          try {
            const e = JSON.parse(msg.body);
            if (e.type === "ANNOTATION")
              setNotes(prev => [...prev.filter(n => n.id !== e.payload.id), e.payload]);
          } catch {}
        });
      },
      onDisconnect: () => setConnected(false),
    });
    client.activate();
    return () => { client.deactivate(); };
  }, [activeRepo]);

  // Post note
  const postNote = async (jobName: string) => {
    if (!noteText.trim() || !dbRunId) return;
    const res = await fetch(`${API}/pipelines/${dbRunId}/annotations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobName, author: username, content: noteText, type: noteType }),
    });
    if (res.ok) { const saved = await res.json(); setNotes(prev => [...prev, saved]); }
    setNoteText(""); setAddingNote(null);
  };

  const resolveNote = async (note: Note) => {
    const res = await fetch(`${API}/annotations/${note.id}/resolve`, { method: "PATCH" });
    if (res.ok) { const u = await res.json(); setNotes(prev => prev.map(n => n.id === u.id ? u : n)); }
  };

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f0f13; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5; }
        @keyframes ping { 75%,100% { transform: scale(2); opacity: 0; } }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #2d2d3a; border-radius: 4px; }
        button { font-family: inherit; cursor: pointer; border: none; outline: none; }
        input, textarea { font-family: inherit; outline: none; }
        a { color: inherit; text-decoration: none; }
      `}</style>

      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* SIDEBAR                                                           */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        <div style={{ width: 240, background: "#09090d", borderRight: "1px solid #1e1e2e", display: "flex", flexDirection: "column", flexShrink: 0 }}>

          {/* Brand */}
          <div style={{ padding: "16px 14px 12px", borderBottom: "1px solid #1e1e2e" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>⚡</div>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>PipelineSync</span>
              <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: "50%", background: connected ? "#34d399" : "#4b5563", display: "block", flexShrink: 0 }} title={connected ? "Live" : "Offline"} />
            </div>
          </div>

          {/* Repos */}
          <div style={{ padding: "10px 10px 6px", flex: 1, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px", marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#4b5563", letterSpacing: "0.08em" }}>REPOSITORIES</span>
              <button onClick={() => setAddingRepo(true)}
                style={{ fontSize: 16, color: "#6366f1", background: "none", lineHeight: 1, padding: "0 2px" }} title="Add repo">+</button>
            </div>

            {repos.map(repo => (
              <div key={repo}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 6, background: activeRepo === repo ? "#1e1e2e" : "transparent", marginBottom: 2, cursor: "pointer", border: activeRepo === repo ? "1px solid #2d2d4e" : "1px solid transparent" }}
                onClick={() => setActiveRepo(repo)}>
                <span style={{ fontSize: 13 }}>📦</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo.split("/")[0]}</div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: activeRepo === repo ? "#e2e8f0" : "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo.split("/")[1]}</div>
                </div>
                {repos.length > 1 && (
                  <button onClick={e => { e.stopPropagation(); removeRepo(repo); }}
                    style={{ fontSize: 14, color: "#374151", background: "none", padding: "0 2px", lineHeight: 1, opacity: 0, transition: "opacity 0.15s" }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={e => (e.currentTarget.style.opacity = "0")}>×</button>
                )}
              </div>
            ))}

            {/* Add repo form */}
            {addingRepo && (
              <div style={{ marginTop: 8, padding: 8, background: "#1e1e2e", borderRadius: 8, border: "1px solid #2d2d4e" }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>Paste GitHub repo URL or owner/name:</div>
                <input
                  value={newRepo} onChange={e => setNewRepo(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addRepo()}
                  placeholder="e.g. vercel/next.js"
                  autoFocus
                  style={{ width: "100%", background: "#0f0f13", border: "1px solid #374151", borderRadius: 5, padding: "5px 8px", color: "#e2e8f0", fontSize: 12, marginBottom: 6 }}
                />
                <div style={{ display: "flex", gap: 5 }}>
                  <button onClick={addRepo}
                    style={{ flex: 1, padding: "4px 0", background: "#6366f1", color: "#fff", borderRadius: 5, fontSize: 11, fontWeight: 600 }}>Add</button>
                  <button onClick={() => { setAddingRepo(false); setNewRepo(""); }}
                    style={{ flex: 1, padding: "4px 0", background: "#1e1e2e", color: "#6b7280", borderRadius: 5, fontSize: 11, border: "1px solid #2d2d4e" }}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* User */}
          <div style={{ padding: "10px 14px", borderTop: "1px solid #1e1e2e" }}>
            <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 4 }}>YOUR NAME</div>
            <input value={username} onChange={e => setUsername(e.target.value)}
              style={{ width: "100%", background: "#1e1e2e", border: "1px solid #2d2d4e", borderRadius: 5, padding: "4px 8px", color: "#94a3b8", fontSize: 12 }} />
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* RUNS LIST                                                         */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        <div style={{ width: 320, borderRight: "1px solid #1e1e2e", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e1e2e", display: "flex", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "#f1f5f9" }}>{activeRepo.split("/")[1]}</div>
              <div style={{ fontSize: 11, color: "#4b5563" }}>Pipeline runs · auto-refreshes every 15s</div>
            </div>
            <button onClick={fetchRuns} style={{ marginLeft: "auto", fontSize: 13, color: "#6366f1", background: "none", padding: 4 }} title="Refresh">↺</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {error && (
              <div style={{ margin: 12, padding: 10, background: "#f8717115", border: "1px solid #f8717140", borderRadius: 6, fontSize: 11, color: "#f87171" }}>
                ⚠ {error}
              </div>
            )}
            {runsLoading && runs.length === 0 && (
              <div style={{ padding: 30, textAlign: "center", color: "#374151", fontSize: 12 }}>Loading runs...</div>
            )}
            {runs.map(run => {
              const isActive = activeRun?.id === run.id;
              const noteCount = notes.filter(n => n.pipelineRunId === dbRunId).length;
              return (
                <div key={run.id} onClick={() => setActiveRun(run)}
                  style={{ padding: "12px 16px", borderBottom: "1px solid #1e1e2e", cursor: "pointer", background: isActive ? "#13131a" : "transparent", borderLeft: isActive ? "3px solid #6366f1" : "3px solid transparent", transition: "background 0.1s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Pill status={run.status} conclusion={run.conclusion} />
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "#4b5563" }}>
                      {format(new Date(run.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#cbd5e1", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.head_commit?.message || run.display_title}
                  </div>
                  <div style={{ fontSize: 11, color: "#4b5563" }}>
                    <span style={{ color: "#6366f1" }}>#{run.run_number}</span>
                    {" · "}{run.head_branch}
                    {" · "}{run.head_sha?.slice(0, 7)}
                    {" · by "}{run.triggering_actor?.login}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════ */}
        {/* DETAIL PANEL                                                      */}
        {/* ══════════════════════════════════════════════════════════════════ */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {!activeRun ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "#374151" }}>
              <div style={{ fontSize: 32 }}>👈</div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Select a pipeline run</div>
              <div style={{ fontSize: 12 }}>Click any run on the left to see jobs, steps and annotations</div>
            </div>
          ) : (
            <div style={{ padding: 20, maxWidth: 800 }}>

              {/* Run header */}
              <div style={{ background: "#09090d", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                  <Pill status={activeRun.status} conclusion={activeRun.conclusion} />
                  <a href={`https://github.com/${activeRepo}/actions/runs/${activeRun.id}`} target="_blank" rel="noreferrer"
                    style={{ marginLeft: "auto", fontSize: 11, color: "#6366f1", display: "flex", alignItems: "center", gap: 4 }}>
                    View on GitHub ↗
                  </a>
                </div>
                <div style={{ fontWeight: 600, fontSize: 15, color: "#f1f5f9", marginBottom: 8 }}>
                  {activeRun.head_commit?.message || activeRun.display_title}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: "#6b7280" }}>
                  <span>Run <span style={{ color: "#94a3b8" }}>#{activeRun.run_number}</span></span>
                  <span>Branch <span style={{ color: "#818cf8" }}>{activeRun.head_branch}</span></span>
                  <span>Commit <span style={{ color: "#94a3b8" }}>{activeRun.head_sha?.slice(0, 7)}</span></span>
                  <span>By <span style={{ color: "#94a3b8" }}>{activeRun.triggering_actor?.login}</span></span>
                  <span>{formatDistanceToNow(new Date(activeRun.created_at), { addSuffix: true })}</span>
                </div>
              </div>

              {/* Pipeline flow */}
              {jobs.length > 0 && (
                <div style={{ background: "#09090d", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#4b5563", letterSpacing: "0.07em", marginBottom: 14 }}>PIPELINE FLOW</div>
                  <div style={{ display: "flex", alignItems: "center", overflowX: "auto", gap: 0, paddingBottom: 4 }}>
                    {jobs.map((job, i) => (
                      <div key={job.id} style={{ display: "flex", alignItems: "center" }}>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                          <div style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${getColor(job.status, job.conclusion)}`, background: getColor(job.status, job.conclusion) + "18", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 5px" }}>
                            <Dot status={job.status} conclusion={job.conclusion} size={10} />
                          </div>
                          <div style={{ fontSize: 9, color: "#6b7280", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: "0 auto" }}>{job.name}</div>
                        </div>
                        {i < jobs.length - 1 && <div style={{ width: 28, height: 1, background: "#2d2d3a", flexShrink: 0 }} />}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Jobs */}
              {jobsLoading && <div style={{ color: "#374151", fontSize: 12, marginBottom: 12 }}>Loading jobs...</div>}
              {jobs.map(job => {
                const jobNotes = notes.filter(n => n.jobName === job.name);
                const color = getColor(job.status, job.conclusion);
                return (
                  <div key={job.id} style={{ background: "#09090d", border: "1px solid #1e1e2e", borderLeft: `3px solid ${color}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>

                    {/* Job header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px" }}>
                      <Dot status={job.status} conclusion={job.conclusion} size={9} />
                      <span style={{ fontWeight: 600, flex: 1, fontSize: 13 }}>{job.name}</span>
                      <span style={{ fontSize: 11, color }}>{getLabel(job.status, job.conclusion)}</span>
                      <button
                        onClick={() => { setAddingNote(addingNote === job.name ? null : job.name); setNoteText(""); setNoteType("comment"); }}
                        style={{ marginLeft: 8, fontSize: 11, padding: "3px 10px", borderRadius: 5, background: "#1e1e2e", color: "#6b7280", border: "1px solid #2d2d4e" }}>
                        {jobNotes.length > 0 ? `📝 ${jobNotes.length} note${jobNotes.length > 1 ? "s" : ""}` : "+ Add note"}
                      </button>
                    </div>

                    {/* Steps */}
                    {job.steps?.length > 0 && (
                      <div style={{ borderTop: "1px solid #1e1e2e", padding: "8px 14px 10px" }}>
                        {job.steps.map(step => (
                          <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                            <Dot status={step.status} conclusion={step.conclusion} size={6} />
                            <span style={{ fontSize: 11, color: step.conclusion === "failure" ? "#f87171" : step.conclusion === "success" ? "#6b7280" : "#94a3b8" }}>
                              {step.number}. {step.name}
                            </span>
                            {step.conclusion === "failure" && <span style={{ marginLeft: "auto", fontSize: 10, color: "#f87171", fontWeight: 600 }}>FAILED</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add note form */}
                    {addingNote === job.name && (
                      <div style={{ borderTop: "1px solid #1e1e2e", padding: 12, background: "#0b0b10" }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>Type of note:</div>
                        <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                          {["comment", "warning", "error", "info"].map(t => (
                            <button key={t} onClick={() => setNoteType(t)}
                              style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: noteType === t ? 600 : 400, background: noteType === t ? NOTE_COLORS[t] + "20" : "transparent", color: noteType === t ? NOTE_COLORS[t] : "#6b7280", border: `1px solid ${noteType === t ? NOTE_COLORS[t] + "50" : "#2d2d4e"}` }}>
                              {t}
                            </button>
                          ))}
                        </div>
                        <textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={2}
                          placeholder="Write your note here..."
                          style={{ width: "100%", background: "#09090d", border: "1px solid #2d2d4e", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 12, resize: "none" }} />
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button onClick={() => postNote(job.name)}
                            style={{ padding: "5px 16px", background: "#6366f1", color: "#fff", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>Post</button>
                          <button onClick={() => setAddingNote(null)}
                            style={{ padding: "5px 12px", background: "#1e1e2e", color: "#6b7280", borderRadius: 6, fontSize: 12, border: "1px solid #2d2d4e" }}>Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Notes */}
                    {jobNotes.length > 0 && (
                      <div style={{ borderTop: "1px solid #1e1e2e" }}>
                        {jobNotes.map(note => (
                          <div key={note.id} style={{ padding: "10px 14px", borderBottom: "1px solid #1e1e2e", opacity: note.resolved ? 0.45 : 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                              <span style={{ fontWeight: 600, color: NOTE_COLORS[note.type] || "#818cf8", fontSize: 12 }}>{note.author}</span>
                              <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: (NOTE_COLORS[note.type] || "#818cf8") + "20", color: NOTE_COLORS[note.type] || "#818cf8" }}>{note.type}</span>
                              {note.resolved && <span style={{ fontSize: 10, color: "#34d399" }}>✓ resolved</span>}
                              <span style={{ marginLeft: "auto", fontSize: 10, color: "#374151" }}>{formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })}</span>
                            </div>
                            <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>{note.content}</p>
                            <button onClick={() => resolveNote(note)}
                              style={{ marginTop: 6, fontSize: 11, color: note.resolved ? "#374151" : "#34d399", background: "none", padding: 0 }}>
                              {note.resolved ? "↺ Reopen" : "✓ Mark resolved"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
