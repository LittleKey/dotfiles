plugins=(git tmux)
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

ZSH_THEME="powerlevel9k/powerlevel9k"
export POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(pyenv dir dir_writable vcs)
export POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(background_jobs status)
export POWERLEVEL9K_DIR_SHOW_WRITABLE=true
