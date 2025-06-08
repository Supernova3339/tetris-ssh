const { Server } = require('ssh2');
const fs = require('fs');
const crypto = require('crypto');

// Configuration
const MAX_CONNECTIONS_PER_IP = 3;
const MAX_AUTH_ATTEMPTS_PER_IP = 5;
const AUTH_ATTEMPT_WINDOW = 300000; // 5 minutes
const CONNECTION_TIMEOUT = 300000; // 5 minutes
const MAX_HIGHSCORE_ENTRIES = 100;
const MAX_PLAYER_HISTORY = 5;
const DATA_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Storage
const HIGHSCORE_FILE = 'tetris_highscores.json';
const PLAYER_DATA_FILE = 'tetris_players.json';
let highScores = [];
let playerData = {};

// Protection tracking
const connectionLimits = new Map();
const authAttempts = new Map();

// Tetris pieces
const PIECES = {
    I: { shapes: [[[1,1,1,1]], [[1],[1],[1],[1]]], color: '\x1b[96m' },
    O: { shapes: [[[1,1],[1,1]]], color: '\x1b[93m' },
    T: { shapes: [[[0,1,0],[1,1,1]], [[1,0],[1,1],[1,0]], [[1,1,1],[0,1,0]], [[0,1],[1,1],[0,1]]], color: '\x1b[95m' },
    S: { shapes: [[[0,1,1],[1,1,0]], [[1,0],[1,1],[0,1]]], color: '\x1b[92m' },
    Z: { shapes: [[[1,1,0],[0,1,1]], [[0,1],[1,1],[1,0]]], color: '\x1b[91m' },
    J: { shapes: [[[1,0,0],[1,1,1]], [[1,1],[1,0],[1,0]], [[1,1,1],[0,0,1]], [[0,1],[0,1],[1,1]]], color: '\x1b[94m' },
    L: { shapes: [[[0,0,1],[1,1,1]], [[1,0],[1,0],[1,1]], [[1,1,1],[1,0,0]], [[1,1],[0,1],[0,1]]], color: '\x1b[97m' }
};

const RESET = '\x1b[0m';

// Game states
const STATES = {
    WELCOME: 'welcome',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'gameOver',
    HIGH_SCORES: 'highScores',
    ACCOUNT_MENU: 'accountMenu',
    ACCOUNT_EXPORT: 'accountExport',
    ACCOUNT_DELETE: 'accountDelete'
};

// Utility functions
function getClientIP(client) {
    return client.connection?.remoteAddress || 'unknown';
}

function isIPBlocked(ip) {
    const attempts = authAttempts.get(ip);
    if (!attempts) return false;
    const recentAttempts = attempts.filter(time => Date.now() - time < AUTH_ATTEMPT_WINDOW);
    return recentAttempts.length >= MAX_AUTH_ATTEMPTS_PER_IP;
}

function recordAuthAttempt(ip) {
    if (!authAttempts.has(ip)) {
        authAttempts.set(ip, []);
    }
    authAttempts.get(ip).push(Date.now());
}

function getActiveConnections(ip) {
    return connectionLimits.get(ip) || 0;
}

function addConnection(ip) {
    connectionLimits.set(ip, getActiveConnections(ip) + 1);
}

function removeConnection(ip) {
    const current = getActiveConnections(ip);
    if (current <= 1) {
        connectionLimits.delete(ip);
    } else {
        connectionLimits.set(ip, current - 1);
    }
}

// Data management
function loadHighScores() {
    try {
        if (fs.existsSync(HIGHSCORE_FILE)) {
            const data = fs.readFileSync(HIGHSCORE_FILE, 'utf8');
            highScores = JSON.parse(data);
        }
    } catch (err) {
        console.log('Error loading high scores:', err.message);
        highScores = [];
    }
}

function saveHighScores() {
    try {
        fs.writeFileSync(HIGHSCORE_FILE, JSON.stringify(highScores, null, 2));
    } catch (err) {
        console.log('Error saving high scores:', err.message);
    }
}

function loadPlayerData() {
    try {
        if (fs.existsSync(PLAYER_DATA_FILE)) {
            const data = fs.readFileSync(PLAYER_DATA_FILE, 'utf8');
            playerData = JSON.parse(data);
        }
    } catch (err) {
        console.log('Error loading player data:', err.message);
        playerData = {};
    }
}

function savePlayerData() {
    try {
        fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(playerData, null, 2));
    } catch (err) {
        console.log('Error saving player data:', err.message);
    }
}

function getPlayerIdentity(publicKey) {
    try {
        const keyData = publicKey.toString();
        const hash = crypto.createHash('sha256').update(keyData).digest('hex');
        const fingerprint = hash.substring(0, 16);

        let playerName = fingerprint;
        const userIdMatch = keyData.match(/<([^>]+)>/);
        if (userIdMatch) {
            playerName = userIdMatch[1];
        } else {
            const emailMatch = keyData.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) {
                playerName = emailMatch[1];
            }
        }

        if (!playerData[fingerprint]) {
            playerData[fingerprint] = {
                name: playerName,
                fingerprint: fingerprint,
                firstSeen: new Date().toISOString(),
                scores: []
            };
        }

        playerData[fingerprint].lastSeen = new Date().toISOString();
        playerData[fingerprint].name = playerName;

        return {
            id: fingerprint,
            name: playerName,
            fingerprint: fingerprint
        };
    } catch (err) {
        console.log('Error processing SSH key:', err.message);
        return null;
    }
}

function updateHighScore(player, score, level, lines) {
    const existingIndex = highScores.findIndex(entry => entry.playerId === player.id);

    const scoreEntry = {
        playerId: player.id,
        playerName: player.name,
        score: score,
        level: level,
        lines: lines,
        date: new Date().toISOString()
    };

    if (!playerData[player.id].scores) {
        playerData[player.id].scores = [];
    }
    playerData[player.id].scores.unshift(scoreEntry);

    if (playerData[player.id].scores.length > MAX_PLAYER_HISTORY) {
        playerData[player.id].scores = playerData[player.id].scores.slice(0, MAX_PLAYER_HISTORY);
    }

    if (existingIndex >= 0) {
        if (score > highScores[existingIndex].score) {
            highScores[existingIndex] = scoreEntry;
        }
    } else {
        highScores.push(scoreEntry);
    }

    highScores.sort((a, b) => b.score - a.score);
    highScores = highScores.slice(0, Math.min(50, MAX_HIGHSCORE_ENTRIES));

    saveHighScores();
    savePlayerData();
    return highScores.findIndex(entry => entry.playerId === player.id) + 1;
}

function getPlayerBestScore(playerId) {
    const playerScore = highScores.find(entry => entry.playerId === playerId);
    return playerScore ? playerScore.score : 0;
}

function deletePlayerAccount(playerId) {
    delete playerData[playerId];
    highScores = highScores.filter(score => score.playerId !== playerId);
    savePlayerData();
    saveHighScores();
    console.log(`Deleted account for player: ${playerId}`);
    return true;
}

function getPlayerDataExport(playerId) {
    const player = playerData[playerId];
    const scores = highScores.filter(score => score.playerId === playerId);

    return {
        playerId: playerId,
        playerInfo: player,
        highScores: scores,
        exportDate: new Date().toISOString(),
        note: "Complete export of your game data and statistics."
    };
}

// Load data
loadHighScores();
loadPlayerData();

class TetrisGame {
    constructor(stream, player) {
        this.stream = stream;
        this.player = player;
        this.state = STATES.WELCOME;

        // Game state
        this.board = Array(20).fill().map(() => Array(10).fill(null));
        this.currentPiece = null;
        this.currentType = null;
        this.currentRotation = 0;
        this.currentX = 0;
        this.currentY = 0;
        this.nextType = null;
        this.score = 0;
        this.level = 1;
        this.lines = 0;
        this.dropTime = 1000;
        this.lastDrop = Date.now();
        this.playerBest = getPlayerBestScore(player.id);

        this.initTerminal();
        this.render();
    }

    initTerminal() {
        this.stream.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[H');
        this.setupInput();
        this.stream.on('close', () => this.cleanup());
    }

    cleanup() {
        this.stream.write('\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H');
    }

    clearScreen() {
        this.stream.write('\x1b[2J\x1b[H');
    }

    moveCursor(row, col) {
        this.stream.write(`\x1b[${row};${col}H`);
    }

    setState(newState) {
        this.state = newState;
        this.render();
    }

    setupInput() {
        this.stream.on('data', (data) => {
            const key = data.toString().toLowerCase();

            // Handle quit from any state
            if (key === 'q' || key === '\x03') {
                this.cleanup();
                this.stream.end();
                return;
            }

            // State-specific input handling
            switch (this.state) {
                case STATES.WELCOME:
                    this.handleWelcomeInput(key);
                    break;
                case STATES.PLAYING:
                    this.handleGameInput(key);
                    break;
                case STATES.PAUSED:
                    this.handlePausedInput(key);
                    break;
                case STATES.GAME_OVER:
                    this.handleGameOverInput(key);
                    break;
                case STATES.HIGH_SCORES:
                    this.handleHighScoresInput(key);
                    break;
                case STATES.ACCOUNT_MENU:
                    this.handleAccountMenuInput(key);
                    break;
                case STATES.ACCOUNT_EXPORT:
                    this.handleAccountExportInput(key);
                    break;
                case STATES.ACCOUNT_DELETE:
                    this.handleAccountDeleteInput(key);
                    break;
            }
        });
    }

    handleWelcomeInput(key) {
        switch (key) {
            case 'h':
                this.setState(STATES.HIGH_SCORES);
                break;
            case 'a':
                this.setState(STATES.ACCOUNT_MENU);
                break;
            default:
                this.startGame();
                break;
        }
    }

    handleGameInput(key) {
        switch (key) {
            case 'a':
            case '\x1b[d':
                this.movePiece(-1, 0);
                break;
            case 'd':
            case '\x1b[c':
                this.movePiece(1, 0);
                break;
            case 's':
            case '\x1b[b':
                if (this.movePiece(0, 1)) {
                    this.score += 1;
                } else {
                    this.placePiece();
                }
                break;
            case 'w':
            case '\x1b[a':
                this.rotatePiece();
                break;
            case ' ':
                this.hardDrop();
                break;
            case 'p':
                this.setState(STATES.PAUSED);
                break;
            case 'r':
                this.restart();
                break;
            case 'h':
                this.setState(STATES.HIGH_SCORES);
                break;
        }
        this.render();
    }

    handlePausedInput(key) {
        if (key === 'p') {
            this.setState(STATES.PLAYING);
        }
    }

    handleGameOverInput(key) {
        switch (key) {
            case 'r':
                this.restart();
                break;
            case 'h':
                this.setState(STATES.HIGH_SCORES);
                break;
            default:
                this.setState(STATES.WELCOME);
                break;
        }
    }

    handleHighScoresInput(key) {
        if (this.state === STATES.PLAYING || this.state === STATES.PAUSED) {
            this.setState(STATES.PLAYING);
        } else {
            this.setState(STATES.WELCOME);
        }
    }

    handleAccountMenuInput(key) {
        switch (key) {
            case 'e':
                this.setState(STATES.ACCOUNT_EXPORT);
                break;
            case 'd':
                this.setState(STATES.ACCOUNT_DELETE);
                break;
            default:
                this.setState(STATES.WELCOME);
                break;
        }
    }

    handleAccountExportInput(key) {
        this.setState(STATES.WELCOME);
    }

    handleAccountDeleteInput(key) {
        if (key === 'y') {
            deletePlayerAccount(this.player.id);
            this.cleanup();
            setTimeout(() => this.stream.end(), 3000);
        } else {
            this.setState(STATES.WELCOME);
        }
    }

    startGame() {
        this.board = Array(20).fill().map(() => Array(10).fill(null));
        this.score = 0;
        this.level = 1;
        this.lines = 0;
        this.dropTime = 1000;
        this.lastDrop = Date.now();

        this.spawnNextPiece();
        this.spawnPiece();
        this.setState(STATES.PLAYING);
        this.startGameLoop();
    }

    restart() {
        this.startGame();
    }

    startGameLoop() {
        const loop = () => {
            if (this.state !== STATES.PLAYING) {
                setTimeout(loop, 100);
                return;
            }

            const now = Date.now();
            if (now - this.lastDrop > this.dropTime) {
                if (!this.movePiece(0, 1)) {
                    this.placePiece();
                }
                this.lastDrop = now;
            }

            this.render();
            setTimeout(loop, 50);
        };
        loop();
    }

    spawnNextPiece() {
        const types = Object.keys(PIECES);
        this.nextType = types[Math.floor(Math.random() * types.length)];
    }

    spawnPiece() {
        this.currentType = this.nextType;
        this.spawnNextPiece();

        this.currentRotation = 0;
        this.currentPiece = PIECES[this.currentType].shapes[0];
        this.currentX = Math.floor((10 - this.currentPiece[0].length) / 2);
        this.currentY = 0;

        if (this.checkCollision()) {
            const rank = updateHighScore(this.player, this.score, this.level, this.lines);
            this.setState(STATES.GAME_OVER);
        }
    }

    checkCollision(x = this.currentX, y = this.currentY, piece = this.currentPiece) {
        for (let py = 0; py < piece.length; py++) {
            for (let px = 0; px < piece[py].length; px++) {
                if (piece[py][px]) {
                    const newX = x + px;
                    const newY = y + py;

                    if (newX < 0 || newX >= 10 || newY >= 20) return true;
                    if (newY >= 0 && this.board[newY][newX]) return true;
                }
            }
        }
        return false;
    }

    movePiece(dx, dy) {
        if (!this.checkCollision(this.currentX + dx, this.currentY + dy)) {
            this.currentX += dx;
            this.currentY += dy;
            return true;
        }
        return false;
    }

    rotatePiece() {
        const shapes = PIECES[this.currentType].shapes;
        const newRotation = (this.currentRotation + 1) % shapes.length;
        const newPiece = shapes[newRotation];

        if (!this.checkCollision(this.currentX, this.currentY, newPiece)) {
            this.currentRotation = newRotation;
            this.currentPiece = newPiece;
            return true;
        }
        return false;
    }

    hardDrop() {
        let dropped = 0;
        while (this.movePiece(0, 1)) {
            dropped++;
        }
        this.score += dropped * 2;
        this.placePiece();
    }

    placePiece() {
        for (let py = 0; py < this.currentPiece.length; py++) {
            for (let px = 0; px < this.currentPiece[py].length; px++) {
                if (this.currentPiece[py][px]) {
                    const boardY = this.currentY + py;
                    const boardX = this.currentX + px;
                    if (boardY >= 0) {
                        this.board[boardY][boardX] = this.currentType;
                    }
                }
            }
        }

        this.clearLines();
        this.spawnPiece();
    }

    clearLines() {
        let linesCleared = 0;
        for (let y = 19; y >= 0; y--) {
            if (this.board[y].every(cell => cell !== null)) {
                this.board.splice(y, 1);
                this.board.unshift(Array(10).fill(null));
                linesCleared++;
                y++;
            }
        }

        if (linesCleared > 0) {
            this.lines += linesCleared;
            const scoreValues = [0, 100, 300, 500, 800];
            this.score += scoreValues[linesCleared] * this.level;
            this.level = Math.floor(this.lines / 10) + 1;
            this.dropTime = Math.max(100, 1000 - (this.level - 1) * 100);
        }
    }

    render() {
        this.clearScreen();

        switch (this.state) {
            case STATES.WELCOME:
                this.renderWelcome();
                break;
            case STATES.PLAYING:
            case STATES.PAUSED:
                this.renderGame();
                break;
            case STATES.GAME_OVER:
                this.renderGameOver();
                break;
            case STATES.HIGH_SCORES:
                this.renderHighScores();
                break;
            case STATES.ACCOUNT_MENU:
                this.renderAccountMenu();
                break;
            case STATES.ACCOUNT_EXPORT:
                this.renderAccountExport();
                break;
            case STATES.ACCOUNT_DELETE:
                this.renderAccountDelete();
                break;
        }
    }

    renderWelcome() {
        this.moveCursor(2, 8);
        this.stream.write('+' + '='.repeat(64) + '+');

        this.moveCursor(3, 8);
        this.stream.write('|' + ' '.repeat(20) + '\x1b[96mSSH TETRIS\x1b[0m' + ' '.repeat(34) + '|');

        this.moveCursor(4, 8);
        this.stream.write('+' + '='.repeat(64) + '+');

        this.moveCursor(6, 8);
        this.stream.write(`|  Welcome back, \x1b[93m${this.player.name}\x1b[0m!` + ' '.repeat(64 - 17 - this.player.name.length) + '|');

        this.moveCursor(7, 8);
        this.stream.write(`|  Your best score: \x1b[92m${this.playerBest.toLocaleString()}\x1b[0m` + ' '.repeat(64 - 20 - this.playerBest.toLocaleString().length) + '|');

        this.moveCursor(9, 8);
        this.stream.write('|  Controls: A/D-Move  W-Rotate  S-Drop  Space-Hard Drop    |');
        this.moveCursor(10, 8);
        this.stream.write('|            P-Pause   R-Restart Q-Quit                    |');

        this.moveCursor(12, 8);
        this.stream.write('|  \x1b[93mH\x1b[0m - View Leaderboard                                      |');
        this.moveCursor(13, 8);
        this.stream.write('|  \x1b[93mA\x1b[0m - Account Settings                                      |');

        this.moveCursor(15, 8);
        this.stream.write('|  Goal: Complete horizontal lines to clear them!           |');

        this.moveCursor(17, 8);
        this.stream.write('+' + '='.repeat(64) + '+');

        this.moveCursor(19, 20);
        this.stream.write('\x1b[93mPress any key to start playing!\x1b[0m');
    }

    renderGame() {
        // Game board
        this.moveCursor(1, 20);
        this.stream.write('\x1b[96mSSH TETRIS\x1b[0m');

        this.moveCursor(3, 5);
        this.stream.write('+' + '-'.repeat(20) + '+');

        for (let i = 0; i < 20; i++) {
            this.moveCursor(4 + i, 5);
            this.stream.write('|');
            this.moveCursor(4 + i, 26);
            this.stream.write('|');
        }

        this.moveCursor(24, 5);
        this.stream.write('+' + '-'.repeat(20) + '+');

        // Render board content
        const displayBoard = this.board.map(row => [...row]);

        if (this.currentPiece && this.state === STATES.PLAYING) {
            for (let py = 0; py < this.currentPiece.length; py++) {
                for (let px = 0; px < this.currentPiece[py].length; px++) {
                    if (this.currentPiece[py][px]) {
                        const boardY = this.currentY + py;
                        const boardX = this.currentX + px;
                        if (boardY >= 0 && boardY < 20 && boardX >= 0 && boardX < 10) {
                            displayBoard[boardY][boardX] = this.currentType;
                        }
                    }
                }
            }
        }

        for (let y = 0; y < 20; y++) {
            this.moveCursor(4 + y, 6);
            for (let x = 0; x < 10; x++) {
                const cell = displayBoard[y][x];
                if (cell === null) {
                    this.stream.write('  ');
                } else {
                    const color = PIECES[cell].color;
                    this.stream.write(`${color}[]${RESET}`);
                }
            }
        }

        // Next piece
        this.moveCursor(3, 30);
        this.stream.write('NEXT:');
        if (this.nextType) {
            const piece = PIECES[this.nextType].shapes[0];
            const color = PIECES[this.nextType].color;

            for (let y = 0; y < piece.length; y++) {
                this.moveCursor(5 + y, 30);
                for (let x = 0; x < piece[y].length; x++) {
                    if (piece[y][x]) {
                        this.stream.write(`${color}[]${RESET}`);
                    } else {
                        this.stream.write('  ');
                    }
                }
            }
        }

        // Stats
        this.moveCursor(10, 30);
        this.stream.write(`Score: ${this.score.toLocaleString()}`);
        this.moveCursor(11, 30);
        this.stream.write(`Level: ${this.level}`);
        this.moveCursor(12, 30);
        this.stream.write(`Lines: ${this.lines}`);

        // Controls
        this.moveCursor(15, 30);
        this.stream.write('H - Leaderboard');
        this.moveCursor(16, 30);
        this.stream.write('P - Pause');
        this.moveCursor(17, 30);
        this.stream.write('R - Restart');
        this.moveCursor(18, 30);
        this.stream.write('Q - Quit');

        if (this.state === STATES.PAUSED) {
            this.moveCursor(26, 10);
            this.stream.write('\x1b[93m*** PAUSED - Press P to continue ***\x1b[0m');
        }
    }

    renderGameOver() {
        this.renderGame();

        const isNewBest = this.score > this.playerBest;

        this.moveCursor(10, 8);
        this.stream.write('\x1b[91m+' + '='.repeat(20) + '+\x1b[0m');
        this.moveCursor(11, 8);
        this.stream.write('\x1b[91m|     GAME OVER!     |\x1b[0m');
        this.moveCursor(12, 8);
        this.stream.write('\x1b[91m+' + '='.repeat(20) + '+\x1b[0m');
        this.moveCursor(13, 8);
        this.stream.write(`\x1b[91m| Score: ${this.score.toString().padStart(10)} |\x1b[0m`);
        this.moveCursor(14, 8);
        this.stream.write(`\x1b[91m| Level: ${this.level.toString().padStart(10)} |\x1b[0m`);
        this.moveCursor(15, 8);
        this.stream.write(`\x1b[91m| Lines: ${this.lines.toString().padStart(10)} |\x1b[0m`);

        if (isNewBest) {
            this.moveCursor(16, 8);
            this.stream.write('\x1b[91m|   NEW BEST SCORE!   |\x1b[0m');
        }

        this.moveCursor(17, 8);
        this.stream.write('\x1b[91m+' + '='.repeat(20) + '+\x1b[0m');
        this.moveCursor(18, 8);
        this.stream.write('\x1b[91m| R-Restart H-Scores  |\x1b[0m');
        this.moveCursor(19, 8);
        this.stream.write('\x1b[91m| Any key - Menu      |\x1b[0m');
        this.moveCursor(20, 8);
        this.stream.write('\x1b[91m+' + '='.repeat(20) + '+\x1b[0m');
    }

    renderHighScores() {
        this.moveCursor(2, 15);
        this.stream.write('+' + '='.repeat(50) + '+');

        this.moveCursor(3, 15);
        this.stream.write('|' + ' '.repeat(18) + '\x1b[96mLEADERBOARD\x1b[0m' + ' '.repeat(21) + '|');

        this.moveCursor(4, 15);
        this.stream.write('+' + '='.repeat(50) + '+');

        this.moveCursor(5, 15);
        this.stream.write('| Rank | Player               | Score     | Level |');

        this.moveCursor(6, 15);
        this.stream.write('+' + '-'.repeat(50) + '+');

        for (let i = 0; i < Math.min(10, highScores.length); i++) {
            const score = highScores[i];
            const rank = (i + 1).toString().padStart(4);
            const player = score.playerName.substring(0, 18).padEnd(18);
            const scoreStr = score.score.toLocaleString().padStart(9);
            const level = score.level.toString().padStart(5);

            this.moveCursor(7 + i, 15);
            if (score.playerId === this.player.id) {
                this.stream.write(`|\x1b[93m ${rank} | ${player} | ${scoreStr} | ${level} \x1b[0m|`);
            } else {
                this.stream.write(`| ${rank} | ${player} | ${scoreStr} | ${level} |`);
            }
        }

        for (let i = highScores.length; i < 10; i++) {
            this.moveCursor(7 + i, 15);
            this.stream.write('|      |                      |           |       |');
        }

        this.moveCursor(17, 15);
        this.stream.write('+' + '='.repeat(50) + '+');

        this.moveCursor(19, 25);
        this.stream.write('\x1b[93mPress any key to continue\x1b[0m');
    }

    renderAccountMenu() {
        this.moveCursor(3, 10);
        this.stream.write('+' + '='.repeat(60) + '+');

        this.moveCursor(4, 10);
        this.stream.write('|' + ' '.repeat(18) + '\x1b[96mACCOUNT SETTINGS\x1b[0m' + ' '.repeat(24) + '|');

        this.moveCursor(5, 10);
        this.stream.write('+' + '='.repeat(60) + '+');

        this.moveCursor(7, 10);
        this.stream.write(`|  Player ID: ${this.player.fingerprint}` + ' '.repeat(60 - 15 - this.player.fingerprint.length) + '|');

        this.moveCursor(8, 10);
        this.stream.write(`|  Display Name: ${this.player.name}` + ' '.repeat(60 - 18 - this.player.name.length) + '|');

        const playerInfo = playerData[this.player.id];
        if (playerInfo) {
            this.moveCursor(9, 10);
            this.stream.write(`|  Member Since: ${new Date(playerInfo.firstSeen).toLocaleDateString()}` + ' '.repeat(60 - 18 - new Date(playerInfo.firstSeen).toLocaleDateString().length) + '|');

            this.moveCursor(10, 10);
            this.stream.write(`|  Games Played: ${playerInfo.scores ? playerInfo.scores.length : 0}` + ' '.repeat(60 - 18 - (playerInfo.scores ? playerInfo.scores.length.toString().length : 1)) + '|');

            this.moveCursor(11, 10);
            this.stream.write(`|  Best Score: ${this.playerBest.toLocaleString()}` + ' '.repeat(60 - 16 - this.playerBest.toLocaleString().length) + '|');
        }

        this.moveCursor(13, 10);
        this.stream.write('|' + ' '.repeat(60) + '|');

        this.moveCursor(14, 10);
        this.stream.write('|  Account Management:                                       |');

        this.moveCursor(15, 10);
        this.stream.write('|                                                            |');

        this.moveCursor(16, 10);
        this.stream.write('|  \x1b[93mE\x1b[0m - Export your game data and statistics                 |');

        this.moveCursor(17, 10);
        this.stream.write('|  \x1b[93mD\x1b[0m - Delete your account (WARNING: Permanent!)           |');

        this.moveCursor(18, 10);
        this.stream.write('|                                                            |');

        this.moveCursor(19, 10);
        this.stream.write('|  Your data includes: scores, statistics, and gameplay     |');

        this.moveCursor(20, 10);
        this.stream.write('|  history. We only store what is necessary for the game.   |');

        this.moveCursor(21, 10);
        this.stream.write('|                                                            |');

        this.moveCursor(22, 10);
        this.stream.write('+' + '='.repeat(60) + '+');

        this.moveCursor(24, 20);
        this.stream.write('\x1b[93mPress E, D, or any other key to return\x1b[0m');
    }

    renderAccountExport() {
        const exportData = getPlayerDataExport(this.player.id);

        this.moveCursor(2, 5);
        this.stream.write('\x1b[96mYour Complete Game Data Export:\x1b[0m');
        this.moveCursor(3, 5);
        this.stream.write('='.repeat(70));

        const exportJson = JSON.stringify(exportData, null, 2);
        const lines = exportJson.split('\n');

        for (let i = 0; i < Math.min(lines.length, 20); i++) {
            this.moveCursor(4 + i, 5);
            this.stream.write(lines[i].substring(0, 70));
        }

        if (lines.length > 20) {
            this.moveCursor(24, 5);
            this.stream.write('\x1b[93m(Data truncated for display - full export shown above)\x1b[0m');
        }

        this.moveCursor(26, 5);
        this.stream.write('\x1b[93mPress any key to return to menu\x1b[0m');
    }

    renderAccountDelete() {
        this.moveCursor(8, 15);
        this.stream.write('\x1b[91m+' + '='.repeat(40) + '+\x1b[0m');
        this.moveCursor(9, 15);
        this.stream.write('\x1b[91m|        DELETE ACCOUNT CONFIRMATION        |\x1b[0m');
        this.moveCursor(10, 15);
        this.stream.write('\x1b[91m|                                            |\x1b[0m');
        this.moveCursor(11, 15);
        this.stream.write('\x1b[91m|   This will permanently delete:           |\x1b[0m');
        this.moveCursor(12, 15);
        this.stream.write('\x1b[91m|   • All your high scores                  |\x1b[0m');
        this.moveCursor(13, 15);
        this.stream.write('\x1b[91m|   • Your game statistics                  |\x1b[0m');
        this.moveCursor(14, 15);
        this.stream.write('\x1b[91m|   • Your account data                     |\x1b[0m');
        this.moveCursor(15, 15);
        this.stream.write('\x1b[91m|                                            |\x1b[0m');
        this.moveCursor(16, 15);
        this.stream.write('\x1b[91m|   This action CANNOT be undone!           |\x1b[0m');
        this.moveCursor(17, 15);
        this.stream.write('\x1b[91m|                                            |\x1b[0m');
        this.moveCursor(18, 15);
        this.stream.write('\x1b[91m|   Type Y to confirm, any other key to     |\x1b[0m');
        this.moveCursor(19, 15);
        this.stream.write('\x1b[91m|   cancel and return to menu.              |\x1b[0m');
        this.moveCursor(20, 15);
        this.stream.write('\x1b[91m+' + '='.repeat(40) + '+\x1b[0m');
    }
}

// SSH Server setup
const server = new Server({
    hostKeys: [fs.readFileSync('ssh_host_key')],
    algorithms: {
        kex: [
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group1-sha1'
        ],
        cipher: [
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-gcm',
            'aes256-gcm'
        ],
        hmac: [
            'hmac-sha2-256',
            'hmac-sha2-512',
            'hmac-sha1'
        ],
        compress: ['none']
    }
}, (client) => {
    const clientIP = getClientIP(client);

    // DDoS Protection
    if (getActiveConnections(clientIP) >= MAX_CONNECTIONS_PER_IP) {
        console.log(`Connection limit exceeded for IP: ${clientIP}`);
        client.end();
        return;
    }

    if (isIPBlocked(clientIP)) {
        console.log(`Blocked IP attempted connection: ${clientIP}`);
        client.end();
        return;
    }

    addConnection(clientIP);
    console.log(`Client connected from ${clientIP} (${getActiveConnections(clientIP)}/${MAX_CONNECTIONS_PER_IP})`);

    // Connection timeout
    const timeout = setTimeout(() => {
        console.log(`Connection timeout for ${clientIP}`);
        client.end();
    }, CONNECTION_TIMEOUT);

    client.on('error', (err) => {
        console.log(`Client error from ${clientIP}:`, err.message);
    });

    client.on('authentication', (ctx) => {
        recordAuthAttempt(clientIP);
        console.log(`Authentication attempt from ${clientIP}, method:`, ctx.method);

        if (ctx.method === 'publickey') {
            const player = getPlayerIdentity(ctx.key.data);
            if (player) {
                console.log(`Player authenticated: ${player.name} (${player.fingerprint}) from ${clientIP}`);
                clearTimeout(timeout);
                ctx.accept();
                client.playerInfo = player;
                return;
            }
        }

        console.log(`Authentication rejected for ${clientIP} - no valid SSH key`);
        ctx.reject(['publickey'], false);
    }).on('ready', () => {
        console.log(`Client authenticated successfully from ${clientIP}!`);

        client.on('session', (accept, reject) => {
            const session = accept();

            session.once('pty', (accept, reject, info) => {
                console.log(`PTY requested from ${clientIP}, terminal:`, info.term);
                accept();
            });

            session.once('shell', (accept, reject) => {
                console.log(`Shell requested from ${clientIP}`);
                const stream = accept();

                try {
                    new TetrisGame(stream, client.playerInfo);
                } catch (err) {
                    console.log(`Error creating game for ${clientIP}:`, err.message);
                    stream.end();
                }

                stream.on('error', (err) => {
                    console.log(`Stream error from ${clientIP}:`, err.message);
                });
            });
        });
    });

    client.on('end', () => {
        clearTimeout(timeout);
        removeConnection(clientIP);
        const playerName = client.playerInfo ? client.playerInfo.name : 'unknown';
        console.log(`Client disconnected: ${playerName} from ${clientIP}`);
    });
});

server.on('error', (err) => {
    console.log('Server error:', err.message);
});

// Data cleanup interval
setInterval(() => {
    console.log('Running data cleanup...');

    const now = Date.now();

    // Cleanup auth attempts
    for (const [ip, attempts] of authAttempts.entries()) {
        const recentAttempts = attempts.filter(time => now - time < AUTH_ATTEMPT_WINDOW);
        if (recentAttempts.length === 0) {
            authAttempts.delete(ip);
        } else {
            authAttempts.set(ip, recentAttempts);
        }
    }

    // Cleanup old player data (90+ days inactive)
    for (const [playerId, data] of Object.entries(playerData)) {
        const lastActivity = new Date(data.lastSeen || 0);
        if (now - lastActivity.getTime() > 90 * 24 * 60 * 60 * 1000) {
            delete playerData[playerId];
            highScores = highScores.filter(score => score.playerId !== playerId);
        }
    }

    // Limit high scores
    if (highScores.length > MAX_HIGHSCORE_ENTRIES) {
        highScores = highScores.slice(0, MAX_HIGHSCORE_ENTRIES);
    }

    savePlayerData();
    saveHighScores();

    console.log(`Cleanup complete. ${Object.keys(playerData).length} active players, ${highScores.length} high scores.`);
}, DATA_CLEANUP_INTERVAL);

// Start server
server.listen(2222, '0.0.0.0', function() {
    console.log('SSH Tetris server listening on port 2222');
    console.log('');
    console.log('\x1b[93m⚠️  SSH Key Authentication Required! ⚠️\x1b[0m');
    console.log('');
    console.log('Connect with your SSH key:');
    console.log('  ssh -p 2222 -i ~/.ssh/id_rsa player@localhost');
    console.log('  ssh -p 2222 -i ~/.ssh/id_ed25519 player@localhost');
    console.log('');
    console.log('Players are identified by their SSH key fingerprint.');
    console.log('Game statistics and scores are stored persistently.');
    console.log('');
    console.log('\x1b[96mFeatures:\x1b[0m');
    console.log('  • Global leaderboard with persistent high scores');
    console.log('  • Personal statistics and game history');
    console.log('  • Account management (data export/deletion)');
    console.log('  • DDoS protection and rate limiting');
    console.log('  • Automatic data cleanup and optimization');
    console.log('');
    console.log('Make sure your terminal is at least 80x30 characters');
    console.log('');
    console.log('\x1b[92mServer Status: Online and ready for players!\x1b[0m');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\x1b[93mShutting down SSH Tetris server...\x1b[0m');
    server.close(() => {
        console.log('\x1b[92mServer closed gracefully.\x1b[0m');
        process.exit(0);
    });
});

// Error handling
process.on('uncaughtException', (err) => {
    console.log('\x1b[91mUncaught exception:\x1b[0m', err.message);
    console.log('\x1b[93mServer continuing...\x1b[0m');
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('\x1b[91mUnhandled rejection at:\x1b[0m', promise, '\x1b[91mreason:\x1b[0m', reason);
    console.log('\x1b[93mServer continuing...\x1b[0m');
});