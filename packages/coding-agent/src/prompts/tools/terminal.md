Work in terminals in the omp app's Terminal panel, where the user watches: read their terminals, run long-lived commands, and drive shell sessions on this machine or over SSH.

<instruction>
- `list`: every terminal with its id, kind, state, and directory: the user's shells (`shell`), interactive `bash` calls (`command`), commands you started (`background`), and your sessions (`session`, with the SSH host and `root` when they apply).
- `read`: what a terminal shows, as plain text (`id`; `lines` from the end, default 100). It covers output since the terminal opened, within a bounded history. When the user refers to something in their terminal (an error, a URL, a prompt), `list` and `read` it instead of asking them to paste it.
- `run`: start `command` in a new terminal (`cwd` defaults to the session's) and return after `wait` seconds (default 3) with its first output; the command keeps running after the call. Use it for dev servers, watchers, and other processes the user should be able to see or stop; use `bash` for commands that finish and whose output you need.
- `open`: start a shell session you drive command by command: on this machine, or on `host` over SSH (a configured host, a `~/.ssh/config` alias, or `user@host[:port]`). `label` names its tab. Returns its id once the shell is ready.
- `exec`: type `command` at session `id`'s prompt and return its output and exit code when the prompt comes back, or after `wait` seconds (default 30) while it still runs. The shell keeps its state between commands: directory, environment variables, activated virtualenvs, `sudo -s`. Pagers are off.
- `send`: type `text` and/or press `key` (`enter`, `ctrl-c`, `q` as text, …) into the program running in a session or a `run` terminal: answer its prompt, page it, quit it, or interrupt it. It returns the screen after `wait` seconds (default 2).
- `wait`: wait up to `wait` seconds for session `id`'s command to finish (or a `run` command to exit), then return as `exec` does.
- `stop`: end a terminal you started with `run` or `open` (`id`); it keeps its output. The user's shells and interactive `bash` calls are not yours to stop.
</instruction>

<instruction>
Remote work goes through sessions. To work on another machine, `open` a session to it and `exec` each step there, as a person at a terminal would: `cd`, inspect, edit, restart, check. Read and write remote files with `ssh://host/path` instead of `cat` or heredocs. Do not write throwaway scripts to upload and run, and do not wrap commands in one-off `ssh host '…'` calls through `bash`.
</instruction>

<critical>
- Passwords, passphrases, one-time codes, and new-host-key questions are the user's to answer. When a session stops at one, its result says the user must answer it in the terminal; tell them, then `wait`. Never put a secret in a command, never use `sshpass`, `expect`, or `echo … | sudo -S`, and never `send` an answer to such a prompt.
- `run`, `open`, `exec`, and `send` follow the same approval rules as `bash`.
- One command at a time per session: while one runs, `wait`, interrupt it, or `open` another session for parallel work.
- Check `list` before starting a second copy of a server or session that may already be running; `stop` sessions you no longer need.
</critical>
