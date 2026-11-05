const WebSocket = require("ws");

const Pigeon = async (options = {}) => {

  const state = {
    target: options.target,
    url: null,
    connected: false
  }

  const connect = async () => {
    console.log(`cats`)
  };

  const disconnect = async () => {
    console.log(`nocats`)
  };

  return {
    connect,
    disconnect,

    get url() {
      return state.url;
    },

    get connected() {
      return state.connected;
    }
  }

};

module.exports = Pigeon;
