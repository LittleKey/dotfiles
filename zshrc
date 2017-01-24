export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"

export TERM=xterm-256color

eval "$(pyenv init -)"
tmux new-session -A -s basic
