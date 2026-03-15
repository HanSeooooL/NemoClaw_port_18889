# NemoClaw — OpenClaw Plugin for OpenShell

Run OpenClaw inside an OpenShell sandbox with NVIDIA inference (Nemotron 3 Super 120B via [build.nvidia.com](https://build.nvidia.com), or local vLLM).

## Quick Start

```bash
npm install -g nemoclaw
nemoclaw setup
```

That's it. First run prompts for your NVIDIA API Key (get one from [build.nvidia.com](https://build.nvidia.com)) and saves it to `~/.nemoclaw/credentials.json`.

### Prerequisites

- Node.js 20+
- Docker
- [OpenShell CLI](https://github.com/NVIDIA/OpenShell)

### Ubuntu 24.04 (fresh install)

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Docker
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
newgrp docker

# OpenShell CLI
pip install 'openshell @ git+https://github.com/NVIDIA/OpenShell.git'

# NVIDIA Container Toolkit (if you have a GPU)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# NemoClaw
npm install -g nemoclaw
nemoclaw setup
```

### macOS

```bash
brew install colima docker node
colima start
pip install 'openshell @ git+https://github.com/NVIDIA/OpenShell.git'
npm install -g nemoclaw
nemoclaw setup
```

### Deploy to a cloud VM

```bash
nemoclaw deploy my-gpu-box
```

Requires the [Brev CLI](https://brev.nvidia.com). The deploy script installs Docker, NVIDIA Container Toolkit (if GPU present), and OpenShell on the VM automatically.

## Usage

### Connect to the sandbox

```bash
nemoclaw connect                # local
nemoclaw connect my-gpu-box     # remote Brev instance
```

### Run OpenClaw (inside the sandbox)

```bash
openclaw agent --agent main --local -m "your prompt" --session-id s1
```

### Switch inference providers

```bash
# NVIDIA cloud (Nemotron 3 Super 120B)
openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b

# Local vLLM
openshell inference set --provider vllm-local --model nvidia/nemotron-3-nano-30b-a3b
```

### Monitor

```bash
openshell term
```

### Network egress approval flow

NemoClaw runs with a strict network policy — the sandbox can only reach
explicitly allowed endpoints. When the agent tries to access something new
(a web API, a package registry, etc.), OpenShell intercepts the request and
the TUI prompts the operator to approve or deny it in real time.

To see this in action, run the walkthrough:

```bash
./scripts/walkthrough.sh
```

This opens a split tmux session — TUI on the left, agent on the right.
Try asking the agent something that requires external access:

- *"Write a Python script that fetches the current NVIDIA stock price"*
- *"Install the requests library and get the top story from Hacker News"*

The TUI will show the blocked request and ask you to approve it. Once
approved, the agent completes the task.

Without tmux, run these in two terminals:

```bash
# Terminal 1 — monitor + approve
openshell term

# Terminal 2 — agent
openshell sandbox connect nemoclaw
export NVIDIA_API_KEY=nvapi-...
nemoclaw-start
openclaw agent --agent main --local --session-id live
```

## Architecture

```
nemoclaw/                           Thin TypeScript plugin (in-process with OpenClaw gateway)
├── src/
│   ├── index.ts                    Plugin entry — registers all nemoclaw commands
│   ├── commands/
│   │   ├── launch.ts               Fresh install (prefers OpenShell-native for net-new)
│   │   ├── migrate.ts              Migrate host OpenClaw into sandbox
│   │   ├── connect.ts              Interactive shell into sandbox
│   │   ├── status.ts               Blueprint run state + sandbox health
│   │   └── eject.ts                Rollback to host install from snapshot
│   └── blueprint/
│       ├── resolve.ts              Version resolution, cache management
│       ├── verify.ts               Digest verification, compatibility checks
│       ├── exec.ts                 Subprocess execution of blueprint runner
│       └── state.ts                Persistent state (run IDs, snapshots)
├── openclaw.plugin.json            Plugin manifest
└── package.json                    Commands declared under openclaw.extensions

nemoclaw-blueprint/                 Versioned blueprint artifact (separate release stream)
├── blueprint.yaml                  Manifest — version, profiles, compatibility
├── orchestrator/
│   └── runner.py                   CLI runner — plan / apply / status / rollback
├── policies/
│   └── openclaw-sandbox.yaml       Strict baseline network + filesystem policy
├── migrations/
│   └── snapshot.py                 Snapshot / restore / cutover / rollback logic
└── iac/                            (future) Declarative infrastructure modules
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup.sh` | Host-side setup — gateway, providers, inference route, sandbox |
| `scripts/brev-setup.sh` | Brev bootstrap — installs prerequisites, then runs `setup.sh` |
| `scripts/nemoclaw-start.sh` | Sandbox entrypoint — configures OpenClaw, installs plugin |
| `scripts/walkthrough.sh` | Split-screen walkthrough — agent + TUI approval flow |
| `scripts/fix-coredns.sh` | CoreDNS patch for Colima environments |

## Commands

| Command | Description |
|---------|-------------|
| `openclaw nemoclaw launch` | Fresh install into OpenShell (warns net-new users) |
| `openclaw nemoclaw migrate` | Migrate host OpenClaw into sandbox (snapshot + cutover) |
| `openclaw nemoclaw connect` | Interactive shell into the sandbox |
| `openclaw nemoclaw status` | Blueprint state, sandbox health, inference config |
| `openclaw nemoclaw eject` | Rollback to host installation from snapshot |
| `/nemoclaw` | Slash command in chat (status, eject) |

## Inference Profiles

| Profile | Provider | Model | Use Case |
|---------|----------|-------|----------|
| `default` | NVIDIA cloud | nemotron-3-super-120b-a12b | Production, requires API key |
| `nim-local` | Local NIM service | nemotron-3-super-120b-a12b | On-prem, NIM deployed as pod |
| `vllm` | vLLM | nemotron-3-nano-30b-a3b | Local inference, vLLM on localhost:8000 |

## Design Principles

1. **Thin plugin, versioned blueprint** — Plugin stays small and stable; orchestration logic evolves independently
2. **Respect CLI boundaries** — Plugin commands live under `nemoclaw` namespace, never override built-in OpenClaw commands
3. **Supply chain safety** — Immutable versioned artifacts with digest verification
4. **OpenShell-native for net-new** — Don't force double-install; prefer `openshell sandbox create`
5. **Snapshot everything** — Every migration creates a restorable backup
