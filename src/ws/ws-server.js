const { Server } = require('uws');
const emmitter = require('./emitter');

module.exports = function ({ port }) {
    const wss = new Server({ port });

    wss.on('connection', (socket) => {
        socket.on('message', (message) => {
            console.log('incoming message', message);
            emmitter.emit('CLIENT_MESSAGE', message);
        });

        socket.on('close', () => {
            // unsubscribe
        });
    });

    return wss;
};
