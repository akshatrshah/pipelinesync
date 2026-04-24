# PipelineSync

Real-time collaborative CI/CD annotation platform. Stream live GitHub Actions pipeline events, annotate specific pipeline steps, and resolve issues through WebSocket-synchronized comment threads — without leaving the build.

```
GitHub Webhooks → Kafka → Redis Pub/Sub → WebSocket → React Dashboard
                                    ↓
                              PostgreSQL (annotations, runs)
```

---

## Projects

```
pipelinesync/          ← THIS repo — the main platform
dummy-pipeline-app/    ← separate repo — push this to GitHub to generate live CI/CD runs
```

---

## Architecture

| Layer | Tech | Role |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Dashboard, WebSocket client (STOMP/SockJS) |
| Backend | Spring Boot 3 (Java 21) | REST API, WebSocket server, webhook receiver |
| Message Bus | Apache Kafka | Buffer/fan-out GitHub webhook payloads |
| Pub/Sub | Redis | Fan out pipeline state to all active sessions |
| Database | PostgreSQL 16 | Persist pipeline runs + annotations w/ optimistic locking |
| Proxy | GitHub API (via WebClient) | Pull live job/step details |

---

## File Map

Kept intentionally minimal — entire backend in one Java file, entire frontend in one TSX file.

```
pipelinesync/
├── docker-compose.yml                          # All services (Postgres, Redis, Kafka, app)
├── backend/
│   ├── Dockerfile
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/pipelinesync/
│       │   └── PipelineSyncApplication.java   # ENTIRE backend (entities, repos, controllers, WS, Kafka, Redis)
│       └── resources/
│           └── application.yml
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── index.css
        └── App.tsx                            # ENTIRE frontend (dashboard, WS client, annotations)

dummy-pipeline-app/
├── index.js
├── package.json
└── .github/workflows/ci.yml                  # 6-stage pipeline: Lint → Test → Security → Build → Staging → Prod
```

---

## Quick Start

### Option A — Docker (recommended, runs everything)

```bash
# 1. Clone and enter
git clone <this-repo>
cd pipelinesync

# 2. Set your GitHub token (optional — enables live job data from GitHub API)
cp .env.example .env
# edit .env and add GITHUB_TOKEN=ghp_...

# 3. Launch everything
docker compose up --build

# Dashboard → http://localhost:5173
# Backend API → http://localhost:8080
```

### Option B — Run locally without Docker

**Prerequisites:** Java 21, Maven, Node 20, PostgreSQL, Redis, Kafka

```bash
# Terminal 1 — Backend
cd pipelinesync/backend
export GITHUB_TOKEN=ghp_your_token_here
export GITHUB_WEBHOOK_SECRET=pipelinesync-secret
mvn spring-boot:run

# Terminal 2 — Frontend
cd pipelinesync/frontend
npm install
npm run dev
# → http://localhost:5173
```

---

## Setting Up Real GitHub Integration

To track a real repo's CI/CD pipeline:

### Step 1 — Push the dummy app to GitHub

```bash
cd dummy-pipeline-app
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/dummy-pipeline-app
git push -u origin main
```

### Step 2 — Create a GitHub Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Give it access to your repo with these permissions:
   - **Actions**: Read
   - **Metadata**: Read
3. Copy the token

### Step 3 — Add token to PipelineSync

```bash
# In pipelinesync/.env (create if not exists)
GITHUB_TOKEN=ghp_your_token_here
GITHUB_WEBHOOK_SECRET=pipelinesync-secret
```

Or if running locally:
```bash
export GITHUB_TOKEN=ghp_your_token_here
```

### Step 4 — Set up the GitHub Webhook (for live push events)

> Skip this if you just want to poll — the dashboard can fetch runs via the GitHub API directly.

1. Go to your GitHub repo → Settings → Webhooks → Add webhook
2. **Payload URL**: `https://YOUR_PUBLIC_URL/webhook/github`
   - For local dev, use [ngrok](https://ngrok.com): `ngrok http 8080` → copy the HTTPS URL
3. **Content type**: `application/json`
4. **Secret**: `pipelinesync-secret` (or whatever you set in `GITHUB_WEBHOOK_SECRET`)
5. **Events**: Select individual events → check **Workflow runs**, **Workflow jobs**, **Check runs**
6. Save

### Step 5 — Trigger a pipeline run

```bash
cd dummy-pipeline-app
git commit --allow-empty -m "trigger: test pipeline"
git push
```

Then open the PipelineSync dashboard, select your repo from the sidebar, and watch the run appear live.

---

## Using the Dashboard

### Selecting a Repo
- The sidebar lists all repos PipelineSync has seen webhook events from
- In demo mode (no backend), it shows 3 mock repos with fake data

### Viewing a Pipeline Run
- Click any run in the middle panel to expand its jobs and steps
- The pipeline graph at the top shows the flow and live status of each job
- Status updates stream in via WebSocket in real time

### Annotating
- Click **+ Annotate** on any job card
- Choose a type: `comment`, `warning`, `error`, `info`
- Type your message and click **Post**
- All collaborators viewing the same run see the annotation appear instantly

### Threading
- Click **↩ Reply** on any annotation to start a thread
- Threads are nested under the parent annotation

### Resolving
- Click **✓ Resolve** to mark an annotation resolved (greys it out)
- Click **↺ Reopen** to reopen it
- Resolved state is persisted in PostgreSQL

### Collaborator Presence
- Top-right shows avatars of everyone currently viewing the same repo
- Your username is editable inline

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/repos` | List all repos with pipeline activity |
| `GET` | `/api/pipelines?repo=owner/name` | Get runs for a repo |
| `POST` | `/api/pipelines/simulate` | Create a fake run (demo/testing) |
| `GET` | `/api/pipelines/:id/annotations` | Get annotations for a run |
| `POST` | `/api/pipelines/:id/annotations` | Add annotation |
| `PATCH` | `/api/annotations/:id/resolve` | Toggle resolved state |
| `GET` | `/api/github/runs?repo=owner/name` | Proxy to GitHub Actions API |
| `GET` | `/api/github/runs/:runId/jobs?repo=...` | Proxy to GitHub jobs API |
| `POST` | `/webhook/github` | GitHub webhook receiver |

### WebSocket

Connect via SockJS at `/ws`, subscribe to STOMP topics:

| Topic | Payload |
|-------|---------|
| `/topic/pipeline/{repo_with_underscores}` | `{ type: "PIPELINE_UPDATE" \| "ANNOTATION", payload: ... }` |
| `/topic/annotations/{pipelineId}` | Annotation object |

Send annotations via STOMP:
```
/app/annotate/{pipelineId}  →  { jobName, author, content, type, parentId }
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | *(empty)* | GitHub PAT for API access |
| `GITHUB_WEBHOOK_SECRET` | `pipelinesync-secret` | HMAC secret for webhook verification |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_DB` | `pipelinesync` | Database name |
| `POSTGRES_USER` | `postgres` | DB user |
| `POSTGRES_PASSWORD` | `postgres` | DB password |
| `REDIS_HOST` | `localhost` | Redis host |
| `KAFKA_BOOTSTRAP` | `localhost:9092` | Kafka bootstrap servers |

---

## Demo Mode

If the backend is not running, the frontend automatically falls back to demo mode:
- 3 fake repos with pre-populated runs
- Annotations are stored in React state only (not persisted)
- A yellow banner in the sidebar indicates demo mode

---

## Tech Notes

**Optimistic locking** — Annotations use `@Version` on the JPA entity. If two collaborators resolve the same annotation simultaneously, one gets a `OptimisticLockException` and must retry.

**Kafka topic** — `github-pipeline-events` with event type as key (`workflow_run`, `workflow_job`, `check_run`). Single partition is fine for demo; increase for production.

**Redis channel pattern** — `pipeline:{owner/repo}` — the backend listens with `PatternTopic("pipeline:*")` and fans out to all WebSocket sessions subscribed to that repo's STOMP topic.

**No auth** — Username is just a free-text field in the UI. Add Spring Security + JWT for production.
