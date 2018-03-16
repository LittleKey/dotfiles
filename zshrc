export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"

export TERM=xterm-256color

eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

alias FLAKE8_IGNORE_FLAG='E225,W503,H405,H306,H301,H201,H404,H101'
alias vim='/usr/local/Cellar/vim/8.0.0430/bin/vim'
tmux new-session -A -s basic
export GPG_TTY=$(tty)

_VERSION_NAME=$(pyenv version-name)
if [[ $_VERSION_NAME == "system" ]]; then
    _VERSION_NAME=""
else
    _VERSION_NAME="(${_VERSION_NAME}) "
fi
PS1="${_VERSION_NAME}${PS1}"
