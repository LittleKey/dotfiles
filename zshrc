export LANG=zh_CN.UTF-8
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

export TERM=xterm-256color


alias FLAKE8_IGNORE_FLAG='E225,W503,H405,H306,H301,H201,H404,H101'
tmux new-session -A -s basic
export GPG_TTY=$(tty)
export ENV=test
ZSH_THEME="agnoster";export DEFAULT_USER=littlekey
