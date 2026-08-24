# dsh-omnipotent-preset

An "omnipotent" agent preset for DeepSeek Harness that combines Standard / PTC / Minimal-style capabilities with routing modes (`spec` / `mixed` / `weak` / `react`) and Cordis creation mode.

## Install

Copy this directory to your Harness home:

```powershell
Copy-Item -Path "dsh-omnipotent-preset" -Destination "$env:USERPROFILE\.dsh\.agent-presets\omnipotent" -Recurse -Force
```

Then select the `omnipotent` preset in DSH Web UI or via `/preset omnipotent`.

## Contents

- `agent.cordis.yml` — preset composition
- `preset.yml` — display metadata
- `router-omnipotent.mjs` / `router-core.mjs` — routing logic
- `skills/` — bundled agent skills

## Notes

- No API keys or credentials are stored in this repository.

## License

MIT
