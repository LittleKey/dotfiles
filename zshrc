# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

# Path to your oh-my-zsh installation.
export ZSH=/Users/yogo/.oh-my-zsh

# Set name of the theme to load. Optionally, if you set this to "random"
# it'll load a random theme each time that oh-my-zsh is loaded.
# See https://github.com/robbyrussell/oh-my-zsh/wiki/Themes
# ZSH_THEME="robbyrussell"
ZSH_THEME="powerlevel9k/powerlevel9k"
# export POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(go_version pyenv dir dir_writable vcs)
# export POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(background_jobs command_execution_time)
export POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(pyenv dir dir_writable vcs)
export POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(background_jobs)
export POWERLEVEL9K_DIR_SHOW_WRITABLE=true
export POWERLEVEL9K_VCS_HG_HOOKS=()  # disable hg hook
export POWERLEVEL9K_VCS_SVN_HOOKS=()  # disable svn hook
export POWERLEVEL9K_SHORTEN_DIR_LENGTH=1
export POWERLEVEL9K_SHORTEN_DELIMITER=""
export POWERLEVEL9K_SHORTEN_STRATEGY="truncate_from_right"

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion. Case
# sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment the following line to disable bi-weekly auto-update checks.
# DISABLE_AUTO_UPDATE="true"

# Uncomment the following line to change how often to auto-update (in days).
# export UPDATE_ZSH_DAYS=13

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# The optional three formats: "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load? (plugins can be found in ~/.oh-my-zsh/plugins/*)
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(git tmux zsh-syntax-highlighting zsh-autosuggestions)
source /usr/local/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source /usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh
export ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg-8"  # zsh augosuggestions default value.

if [ "$AUTO_UPDATE_ZSH" != true ]; then
    export DISABLE_AUTO_UPDATE=true # UPDATE was too slow.
else
    echo "AUTO UPDATE ZSH"
fi

source $ZSH/oh-my-zsh.sh

unset DISABLE_AUTO_UPDATE
unset AUTO_UPDATE_ZSH

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='mvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# ssh
# export SSH_KEY_PATH="~/.ssh/rsa_id"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"

export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH=${PATH}:${ANDROID_HOME}/tools
export PATH=${PATH}:${ANDROID_HOME}/platform-tools
export PATH="/usr/local/sbin":${PATH}
export PATH="/usr/local/bin":${PATH}
export PYENV_VIRTUALENV_DISABLE_PROMPT=1
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
export PATH="${PATH}:/usr/local/Cellar/arm-linux-gnueabihf-binutils/2.37/bin"
export PATH="${PATH}:/usr/local/Cellar/aarch64-none-elf/7.2.0/bin"
export HOMEBREW_GITHUB_API_TOKEN="77aa8fd0ec08bd94a04440c2f9de52111f12a771"
export CIRCLE_TOKEN=9b5a22493fd396144733a2b1046c41f580859e74
export GOPROXY="direct"
export GOPRIVATE="code.yogorobot.io,github.com/yogorobot"
export GONOSUMDB="code.yogorobot.io,github.com/yogorobot,github.com"
# export GOINSECURE="code.yogorobot.io/yogoswarm,code.yogorobot.io/yogorobot,code.yogorobot.io/yogosystem,code.yogorobot.io/liaokunyu,code.yogorobot.io/yogocore"
# export NVM_DIR="$HOME/.nvm"
# . "/usr/local/opt/nvm/nvm.sh"

export TERM=screen-256color

export PYTHON_CONFIGURE_OPTS="--enable-framework"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
export PATH="/Users/yogo/.pyenv/shims:${PATH}"

alias FLAKE8_IGNORE_FLAG='E225,W503,H405,H306,H301,H201,H404,H101'
alias vim='/usr/local/bin/vim'
alias vi=vim
alias ctags='/usr/local/bin/ctags'
tmux new-session -A -s basic

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export GPG_TTY=$(tty)
alias tailf=tail -f
alias proxy="http_proxy=http://localhost:1235 https_proxy=http://localhost:1235"
alias proxymac="http_proxy=http://10.243.192.132:41111 https_proxy=http://10.243.192.132:41111"
alias proxylan="http_proxy=http://192.168.43.82:41111 https_proxy=http://192.168.43.82:41111"
alias proxysh="http_proxy=http://10.243.93.183:41236 https_proxy=http://10.243.93.183:41236"
alias proxyss="http_proxy=http://localhost:1080 https_proxy=http://localhost:1080"
export CXXFLAGS="-std=c++11 -stdlib=libc++"
export CC=`which clang`
export CXX=`which clang++`
export FZF_DEFAULT_COMMAND='rg --files --no-ignore --hidden --follow --glob "!.git/*"'

[[ -s "/Users/yogo/.gvm/scripts/gvm" ]] && source "/Users/yogo/.gvm/scripts/gvm"
source "$HOME/.cargo/env"
export fpath=($HOME/github/alacritty $fpath)
alias ls=exa
alias freeswap="sudo pkill -HUP -u _windowserver"

eval `(ssh-agent -s)` && ssh-add -K

alias stern="stern --tail=0"
alias reset="reset && tput te"

defaults write -g InitialKeyRepeat -int 15 # normal minimum is 15 (225 ms)
defaults write -g KeyRepeat -float 1.2 # normal minimum is 2 (30 ms)

alias update_zsh="AUTO_UPDATE_ZSH=true source ~/.zshrc"
