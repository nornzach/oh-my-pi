Read the terminals in the omp app's Terminal panel, and run long-lived commands in new terminals the user can watch.

<instruction>
- `list`: every terminal with its id, kind, state, and directory: the user's shells (`shell`), interactive `bash` calls (`command`), and commands you started (`background`).
- `read`: what a terminal shows, as plain text (`id`; `lines` from the end, default 100). It covers output since the terminal opened, within a bounded history. When the user refers to something in their terminal (an error, a URL, a prompt), `list` and `read` it instead of asking them to paste it.
- `run`: start `command` in a new terminal (`cwd` defaults to the session's) and return after `wait` seconds (default 3) with its first output; the command keeps running after the call. Use it for dev servers, watchers, and other processes the user should be able to see or stop; use `bash` for commands that finish and whose output you need.
- `stop`: end a command you started with `run` (`id`); its terminal keeps the output. The user's shells and interactive `bash` calls are not yours to stop.
</instruction>

<critical>
- `run` follows the same approval rules as `bash`.
- Check `list` before starting a second copy of a server that may already be running.
</critical>
