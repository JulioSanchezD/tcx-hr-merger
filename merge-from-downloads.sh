#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
poll_seconds="${TCX_HR_POLL_SECONDS:-10}"

usage() {
  cat <<'EOF'
Usage:
  ./merge-from-downloads.sh          Merge the current activity files once
  ./merge-from-downloads.sh --watch  Keep watching Downloads for new files

Environment:
  TCX_HR_DOWNLOADS     Override the Downloads directory used by the merger
  TCX_HR_POLL_SECONDS   Watch interval in seconds (default: 10)
EOF
}

ensure_dependencies() {
  if [[ ! -d "$script_dir/node_modules/@garmin/fitsdk" ]]; then
    echo "Installing Node.js dependencies..."
    (cd "$script_dir" && npm ci)
  fi
}

run_merge() {
  echo "Running activity merger..."
  node "$script_dir/merge-tcx-to-fit.js"
}

activity_signature() {
  MERGER_SCRIPT="$script_dir/merge-tcx-to-fit.js" node --input-type=module -e '
    import fs from "node:fs";
    const { discoverActivityFiles } = await import(process.env.MERGER_SCRIPT);
    const outputName = "merged-indoor-cycling.fit";
    for (const filename of discoverActivityFiles()) {
      if (!filename.toLowerCase().endsWith(outputName)) {
        const stat = fs.statSync(filename);
        console.log(`${filename}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  ' 2>/dev/null
}

ensure_dependencies

case "${1:-}" in
  "")
    run_merge
    ;;
  --watch)
    previous_signature=""
    echo "Watching Downloads every ${poll_seconds}s. Press Ctrl+C to stop."
    while true; do
      current_signature="$(activity_signature || true)"
      if [[ -n "$current_signature" && "$current_signature" != "$previous_signature" ]]; then
        if run_merge; then
          previous_signature="$current_signature"
        else
          echo "Merge failed; will retry when the files change or on the next scan."
        fi
      fi
      sleep "$poll_seconds"
    done
    ;;
  --help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
