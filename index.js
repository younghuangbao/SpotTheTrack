const express = require('express');
const cors = require('cors');
const socketio = require('socket.io');
const uuid = require('short-uuid');
const axios = require('axios');
const queryString = require('query-string');

const app = express();

app.use(cors());
app.use(express.json({ extended: false }));

// Define Routes
app.use('/api/spotify', require('./api/spotify'));
app.use('/api/lobby', require('./api/lobby'));

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () =>
  console.log(`Server started on port ${PORT}`)
);

const backendBaseURL =
  process.env.PRODUCTION_BACK_END || 'http://localhost:5000';

// global variable storing the rooms
var rooms = {};

// global variable keeping track of the room for each socket
var roomOfSocket = {};

const io = socketio(server);

io.on('connection', (socket) => {
  console.log('New websocket connection: ' + socket.id);

  socket.on('createRoom', (name) => {
    // Generates a new unique id for the room
    newRoom = uuid.generate();

    // construct host object
    let host = {
      socket_id: socket.id,
      host: true,
      name,
      score: 0,
      // this answered attribute can be used in the future to check if next round can start earlier
      // upon everyone answering before the end of the current round
      answered: false,
    };

    // set nickname for socket
    socket.nickname = name;

    // map socket_id to room
    roomOfSocket[socket.id] = newRoom;

    // append player to room
    rooms[newRoom] = {
      players: [host],
      settings: {
        timer: 30,
        numRounds: 5,
        artists: [],
      },
      roundChat: [],
      correctRoundGuesses: 0,
    };

    // socket functionality to join room and tell frontend
    socket.join(newRoom);
    socket.emit('newRoom', newRoom);
    socket.emit('roomInfo', rooms[newRoom]);
  });

  socket.on('joinRoom', ({ name, room }) => {
    socket.join(room);

    // construct player object
    let player = {
      socket_id: socket.id,
      host: false,
      name,
      score: 0,
      answered: false,
    };

    // set nickname for socket
    socket.nickname = name;

    // map socket_id to room
    roomOfSocket[socket.id] = room;

    // append player to room
    rooms[room].players.push(player);

    // send frontend update room information
    io.in(room).emit('roomInfo', rooms[room]);
    socket.to(room).emit('newUser', player.name);
  });

  socket.on('updateSettings', ({ room, settings }) => {
    rooms[room].settings = settings;
    io.in(room).emit('updateSettings', settings);
  });

  socket.on('prepareGame', async ({ room, settings }) => {
    console.log(settings);
    console.log(rooms[room]);
    // rooms[settings.room] = settings;

    // .... Do some prep work
    try {
      let artists = queryString.stringify(
        { artists: settings.artists },
        { arrayFormat: 'bracket' }
      );
      let limit = queryString.stringify({ limit: settings.numRounds });
      const response = await axios.get(
        `${backendBaseURL}/api/spotify/initializeGameState`,
        {
          params: {
            artists: artists,
            limit: limit,
          },
        }
      );
      const data = JSON.parse(response.data);

      if ('error' in data) {
        socket.emit('numTracksError', settings.artists);
      } else {
        let x = 0;
        rooms[room].correctRoundGuesses = 0;
        rooms[room].roundChat = [];
        rooms[room].players = rooms[room].players.map((player) => {
          let ret = {
            socket_id: player.socket_id,
            host: player.host,
            name: player.name,
            score: 0,
            answered: false,
          };
          return ret;
        });

        // send countdown to clients in room
        io.in(room).emit('initialCountdown', {
          initialTimerKey: -1,
          serverTime: Date.now() + 5000,
          trackList: data.tracks,
          playerInfo: rooms[room].players,
          roundChat: rooms[room].roundChat,
        });

        // wait 5 seconds before actually starting the game
        setTimeout(() => {
          // TODO: need try-catch here
          try {
            rooms[room].roundChat = [];
            io.in(room).emit('newRound', {
              track: data.tracks[x++],
              round: x,
              serverTime: Date.now() + settings.timer * 1000,
              roundChat: rooms[room].roundChat,
            });

            let interval = setInterval(() => {
              if (!(room in rooms)) {
                clearInterval(interval);
              } else {
                if (x >= parseInt(settings.numRounds)) {
                  clearInterval(interval);
                  io.in(room).emit('endOfGame');
                } else {
                  rooms[room].correctRoundGuesses = 0;
                  for (let i = 0; i < rooms[room].players.length; i++) {
                    rooms[room].players[i].answered = false;
                  }
                  rooms[room].roundChat = [];
                  io.in(room).emit('playerInfo', rooms[room].players);
                  io.in(room).emit('newRound', {
                    track: data.tracks[x++],
                    round: x,
                    serverTime: Date.now() + settings.timer * 1000,
                    roundChat: rooms[room].roundChat,
                  });
                }
              }
            }, (parseInt(settings.timer) + 2.5) * 1000);
          } catch(err) {
            console.error(err);
          }
        }, 5000);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('correctGuess', (room) => {
    const calcScore = (base, correctGuesses) => {
      return Math.floor(base * Math.pow(0.8, correctGuesses));
    };

    rooms[room].correctRoundGuesses++;

    for (let idx = 0; idx < rooms[room].players.length; ++idx) {
      if (rooms[room].players[idx].socket_id === socket.id) {
        rooms[room].players[idx].score += calcScore(
          125,
          rooms[room].correctRoundGuesses
        );
        rooms[room].players[idx].answered = true;
      }
    }

    console.log(rooms[room].players);

    io.in(room).emit('playerInfo', rooms[room].players);
  });

  socket.on('chat', ({ room, name, socketid, time, text }) => {
    var newMsg = { name, socketid, time, text };
    rooms[room].roundChat.push(newMsg);
    io.in(room).emit('chat', rooms[room].roundChat);
  });

  socket.on('disconnect', () => {
    console.log('Websocket ' + socket.id + ' has left.');
    if (socket.id in roomOfSocket) {
      io.of('/')
        .in(roomOfSocket[socket.id])
        .clients((err, clients) => {
          if (err) {
            console.error(err);
          } else {
            let tmpRoomInfo;
            // delete room if all clients have disconnected from room
            if (clients.length <= 0) {
              tmpRoomInfo = rooms[roomOfSocket[socket.id]];
              console.log(`Room will be deleted: ${roomOfSocket[socket.id]}`);
              delete rooms[roomOfSocket[socket.id]];
              console.log(`Deleted room: ${rooms[roomOfSocket[socket.id]]}`); // should be undefined
            }

            try {
              // delete the disconnected socket from memory
              if (roomOfSocket[socket.id] in rooms) {
                // find and delete player associated to socket in rooms
                let players;
                if (roomOfSocket[socket.id] in rooms) {
                  players = rooms[roomOfSocket[socket.id]].players;
                } else {
                  players = tmpRoomInfo.players;
                }

                if (
                  players.find((player) => player.socket_id === socket.id)
                    .host &&
                  clients.length > 0
                ) {
                  players = players.filter(
                    (player) => player.socket_id !== socket.id
                  );

                  // change host and tell client
                  players[0].host = true;
                  io.to(players[0].socket_id).emit('changeHost');
                } else {
                  players = players.filter(
                    (player) => player.socket_id !== socket.id
                  );
                }

                // Update room information in server
                rooms[roomOfSocket[socket.id]].players = players;

                // Update room information in client
                io.to(roomOfSocket[socket.id]).emit(
                  'roomInfo',
                  rooms[roomOfSocket[socket.id]]
                );

                io.to(roomOfSocket[socket.id]).emit(
                  'userDisconnected',
                  socket.nickname
                );
              }
            } catch (err) {
              console.error(err);
            }

            delete roomOfSocket[socket.id];
            console.log(`deleted Websocket ${socket.id} from memory`);
          }
        });
    } else {
      console.log('Websocket ' + socket.id + ' was not part of any game room.');
    }
  });
});

exports.rooms = rooms;
