#!/bin/bash

CURRENT_DIR=`pwd`

# link slate config file
ln -f ${CURRENT_DIR}/.slate ${HOME}/.slate

# link tmux config file
if [ -e ${CURRENT_DIR}/k-tmux/tmux.conf ];
then
    ln -f ${CURRENT_DIR}/k-tmux/tmux.conf ${HOME}/.tmux.conf
else
    echo '[WARNING] t-mux config file is not exists.'
fi

# install k-vim
cd ${CURRENT_DIR}/k-vim && sh -x install.sh
