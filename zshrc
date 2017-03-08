export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"

export TERM=xterm-256color

eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

alias vim='/usr/local/Cellar/vim/8.0.0430/bin/vim'
tmux new-session -A -s basic
