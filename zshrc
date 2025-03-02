ZSH_THEME=""

plugins=(git tmux zsh-syntax-highlighting zsh-autosuggestions)
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
export ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg-8"  # zsh augosuggestions default value.

if [ "$AUTO_UPDATE_ZSH" != true ]; then
    export DISABLE_AUTO_UPDATE=true # UPDATE was too slow.
else
    echo "AUTO UPDATE ZSH"
fi

unset DISABLE_AUTO_UPDATE
unset AUTO_UPDATE_ZSH

# You may need to manually set your language environment
export LANG=en_US.UTF-8

export PYENV_VIRTUALENV_DISABLE_PROMPT=1
export TERM=screen-256color

alias vim=/opt/homebrew/bin/nvim
alias vi=vim

# tmux new-session -A -s basic
alias attach=tmux new-session -A -s basic

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export FZF_DEFAULT_COMMAND='rg --files --no-ignore --hidden --follow --glob "!.git/*"'

alias proxy="all_proxy=http://localhost:7890"

eval `(ssh-agent -s)` && ssh-add --apple-use-keychain

alias reset="reset && tput te"

defaults write -g InitialKeyRepeat -int 15 # normal minimum is 15 (225 ms)
defaults write -g KeyRepeat -float 1.2 # normal minimum is 2 (30 ms)

alias update_zsh="AUTO_UPDATE_ZSH=true source ~/.zshrc"
export PATH="${HOME}/.local/bin":$PATH
eval "$(mise activate zsh)"

source <(fzf --zsh)
source /opt/homebrew/share/zsh/site-functions
source "$HOME/.cargo/env"

alias unlock-keychain="security unlock-keychain"

# ai-commit
export OPENAI_API_KEY=""
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

eval "$(starship init zsh)"
