#!/bin/bash

CURRENT_DIR=`pwd`

# append zshrc config
if [ -e ${CURRENT_DIR}/zshrc ];
then
    cat zshrc >> ${HOME}/.zshrc
fi

# link ghostty config
if [ -e ${CURRENT_DIR}/ghostty ];
then
    mkdir -p ${HOME}/.config/ghostty
    ln -f ${CURRENT_DIR}/ghostty.conf ${HOME}/.config/ghostty/config
fi

# link starship
if [ -e ${CURRENT_DIR}/starship.toml ];
then
    ln -f ${CURRENT_DIR}/starship.toml ${HOME}/.config/starship.toml
fi

# link slate config file
ln -f ${CURRENT_DIR}/slate ${HOME}/.slate

# link tmux config file
if [ -e ${CURRENT_DIR}/k-tmux/install.sh ];
then
    sh -x ${CURRENT_DIR}/k-tmux/install.sh
else
    echo '[WARNING] t-mux install script is not exists.'
fi

# link git config file
if [ -e ${CURRENT_DIR}/gitconfig ];
then
    if [ "$(uname -s)" == "Darwin" ]; then
      brew install git-delta
    fi
    ln -f ${CURRENT_DIR}/gitconfig ${HOME}/.gitconfig
else
    echo '[WARNING] git config file is not exists.'
fi

# install k-vim
(cd ${CURRENT_DIR}/k-vim || exit) && sh -x install.sh
