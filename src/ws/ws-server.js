const WebSocketClient = require('uws');

const createPhoenix = require('phoenix');
const { parseMessage, arnaux, protocol: { frontService, stateService, ui } } = require('message-factory');
const { error, warn, log } = require('steno');

const config = require('../../config');

const Server = WebSocketClient.Server;
const phoenix = createPhoenix(WebSocketClient, { uri: config.get('ARNAUX_URL'), timeout: 500 });

const createLobby = require('./lobby');
const createHall = require('./hall');

const MESSAGE_NAME = frontService.MESSAGE_NAME;

const lobby = createLobby();
const hall = createHall();

let parseCookie = null;

function verifyAuth(ws) {
    const req = ws.upgradeReq;

    return new Promise((resolve, reject) => {
        parseCookie(req, null, () => {
            const uid = req.cookies['secret'];
            const sessionId = req.cookies['sessionId'];

            if (uid && sessionId) {
                // TODO: get user profile by uid
                resolve([uid, sessionId]);
            } else {
                reject();
            }
        });
    });
}

// -------------- Connection management --------------

function clearConnection(ws) {
    // TODO: clear onerror?
    ws.removeAllListeners();
}

function rejectConnection(ws) {
    clearConnection(ws);
    // prevent client phoenix from reconnect
    ws.close(4500);
}

// -------------- Send messages helpers --------------

function sendToGameMasters(sessionId, message) {
    hall.getMasters(sessionId).forEach(([ws]) => {
        ws.send(message);
    });
}

function sendToPlayers(sessionId, message) {
    hall.getPlayers(sessionId).forEach(([ws]) => {
        ws.send(message);
    });
}

function sendToSession(sessionId, message) {
    sendToGameMasters(sessionId, message);
    sendToPlayers(sessionId, message);
}

// -------------- Client messages --------------

function handleClientMessage(ws, message) {
    const participant = hall.get(ws);

    if (!participant) {
        // unknown client
        return;
    }

    const [, participantId, sessionId] = participant;

    switch (message.name) {
        case MESSAGE_NAME.solution:
            return phoenix.send(stateService.participantInput(sessionId, participantId, message.input, Date.now()));
        default:
            return console.warn('[front-service]', '[ws-server]', 'Unknown message from client', message.name);
    }
}

// -------------- Sessions state management --------------

function removeFromLobby(ws, participantId, sessionId) {
    lobby.remove(ws, participantId, sessionId);
    rejectConnection(ws);
}

function addToLobby(ws, participantId, sessionId) {
    const participant = lobby.get(ws, participantId, sessionId);

    if (participant) {
        // if there is already such participant in lobby
        // remove the existing and add a new one
        removeFromLobby(...participant);
        // do not notify session state as nothing is changed except the connection (ws)
    }

    lobby.add(ws, participantId, sessionId);
    ws.once('close', () => {
        // do not pass participantId and sessionId
        // a new connection with this info may already be added
        // need to search by ws only
        removeFromLobby(ws);
        phoenix.send(stateService.sessionLeave(sessionId, participantId));
    });
}

function removeFromHall(ws, participantId, sessionId, role) {
    hall.remove(ws, participantId, sessionId, role);
    rejectConnection(ws);
}

function addToHall(ws, participantId, sessionId, role) {
    const participant = hall.get(ws, participantId, sessionId, role);

    if (participant) {
        // if there is already such participant in the hall
        // remove the existing and add a new one
        removeFromHall(...participant);
        // do not notify session state as nothing is changed except the connection (ws)
    }

    hall.add(ws, participantId, sessionId, role);
    ws.once('close', () => {
        // do not pass participantId and sessionId
        // a new connection with this info may already be added
        // need to search by ws only
        removeFromHall(ws);
        phoenix.send(stateService.sessionLeave(sessionId, participantId));
        sendToGameMasters(sessionId, ui.participantLeft(sessionId, participantId));
    });
    ws.on('message', function onClientMessage(incomingMessage) {
        const { message } = parseMessage(incomingMessage);

        handleClientMessage(this, message);
    });
}

// -------------- Messages handlers --------------

function participantIdentified(participantId, sessionId, role) {
    const participant = lobby.get(null, participantId, sessionId);

    if (!participant) {
        return warn('[ws-server]', 'Unknown participant identification', participantId);
    }

    lobby.remove(...participant);
    clearConnection(participant[0]);
    addToHall(...participant, role);

    sendToGameMasters(sessionId, ui.participantJoined(sessionId, participantId, 'Unknown participant'/* displayName */));
}

function processNewConnection(ws) {
    return verifyAuth(ws)
        .then(([participantId, sessionId]) => {
            addToLobby(ws, participantId, sessionId);
            phoenix.send(stateService.sessionJoin(sessionId, participantId));
        })
        .catch((error) => {
            error('[ws-server]', 'New connection rejected', error);

            rejectConnection(ws);
        });
}

function processServerMessage(message) {
    switch (message.name) {
        case MESSAGE_NAME.participantJoined:
            return participantIdentified(message.participantId, message.sessionId, message.role);
        default:
            return warn('[ws-server]', 'Unknown message from server', message.name);
    }
}

function createWsServer({ port, cookieParser }) {
    const wss = new Server({ port }, () => {
        log('[ws-server]', 'Server is ready on', port);

        wss.on('connection', processNewConnection);
    });

    parseCookie = cookieParser;
}

phoenix
    .on('connected', () => {
        log('[ws-server]', 'phoenix is alive');
        phoenix.send(arnaux.checkin(config.get('ARNAUX_IDENTITY')));
    })
    .on('disconnected', () => {
        error('[ws-server]', 'phoenix disconnected');
    })
    .on('message', (incomingMessage) => {
        const { message } = parseMessage(incomingMessage.data);

        processServerMessage(message);
    });

module.exports = createWsServer;
