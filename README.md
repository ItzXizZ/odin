# Odin — Cursor for Writing

An AI-powered writing workspace built with React, Vite, and Express. Odin helps you gather research, explore ideas, draft with inline AI suggestions, and grade your work against a rubric — all in one app.

## Features

- **Context House** — Upload PDFs and images; Claude summarizes them for use across every mode.
- **Stream of Consciousness** — Free-form voice-to-thought capture to unblock ideas.
- **Exploration** — Branching research canvas with live web search, source tracking, and AI-generated visuals.
- **Write** — Rich-text editor (TipTap) with AI rewrite suggestions and diff-based review.
- **Grade** — Score your draft against a custom rubric with per-criterion feedback.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- An [Anthropic API key](https://console.anthropic.com/) (required)

Optional keys unlock extra capabilities:

| Key | Purpose |
|-----|---------|
| `TAVILY_API_KEY` | Higher-quality web research ([tavily.com](https://tavily.com)) |
| `OPENAI_API_KEY` | AI image generation (recommended) |
| `GOOGLE_API_KEY` | AI image generation via Gemini Imagen |
| `REPLICATE_API_KEY` | AI image generation via Flux Pro |

## Quick start

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/cursor-for-writing.git
cd cursor-for-writing

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run frontend + backend together
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Express API runs on port `3001` by default.

You can also set your Anthropic key in the in-app **Settings** panel without editing `.env`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server and Express API concurrently |
| `npm run client` | Frontend only (Vite on :5173) |
| `npm run server` | Backend only (Express on :3001) |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build |

## Project structure

```
├── src/
│   ├── components/
│   │   ├── ContextHouse/     # PDF & image uploads
│   │   ├── StreamOfConsciousness/
│   │   ├── ExplorationMode/  # React Flow research canvas
│   │   ├── WriteMode/        # TipTap editor + AI diffs
│   │   └── GradeMode/        # Rubric-based grading
│   ├── lib/                  # Claude, research, visual helpers
│   └── store/                # Zustand global state
├── server/
│   └── visual.js             # Image generation providers
└── server.js                 # Express API (chat, research, uploads)
```

## Tech stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, TipTap, React Flow, Framer Motion, Zustand
- **Backend:** Express, Anthropic SDK, pdf-parse, Sharp
- **AI:** Claude (Anthropic) for chat, research, grading, and writing suggestions

## License

MIT
