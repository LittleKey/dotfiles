#!/bin/bash

CURRENT_DIR=`pwd`

# append zshrc config
if [ -e ${CURRENT_DIR}/zshrc ];
then
    cat zshrc >> ${HOME}/.zshrc
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
    ln -f ${CURRENT_DIR}/gitconfig ${HOME}/.gitconfig
else
    echo '[WARNING] git config file is not exists.'
fi

# link flake8 config file
if [ -e ${CURRENT_DIR}/flake8 ];
then
    ln -f ${CURRENT_DIR}/flake8 ${HOME}/.flake8
else
    echo '[WARNING] flake8 config file is not exists.'
fi

# install k-vim
(cd ${CURRENT_DIR}/k-vim || exit) && sh -x install.sh
