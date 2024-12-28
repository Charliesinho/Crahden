const socket = io();

// Select elements
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const usersParent = document.getElementById('usersParent');
const campFire = document.getElementById('campFire');
const users = {};

// Get this user's ID
let myId = null;
socket.on('connect', () => {
    myId = socket.id; // Save your own ID for comparison
});

// Submit event to send messages
form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value) {
        socket.emit('chat message', input.value);
        input.value = '';
    }
});

// Receive user status messages (join/leave)
socket.on('user status', (msg) => {
    const item = document.createElement('li');
    item.textContent = msg;
    item.classList.add('system-message');
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
});

// Receive regular chat messages
socket.on('chat message', (data) => {
    const item = document.createElement('li');
    const userId = document.createElement('span');
    const messageText = document.createElement('span');

    userId.textContent = data.id;
    messageText.textContent = data.text;

    // Add classes based on sender
    if (data.id === myId) {
        item.classList.add('my-message'); // Messages from me
        userId.classList.add('my-id');
    } else {
        item.classList.add('other-message'); // Messages from others
        userId.classList.add('other-id');
    }

    item.appendChild(userId);
    item.appendChild(messageText);
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
});

socket.on('update users', (userList) => {
    // Remove users not in the updated list
    Object.keys(users).forEach((userId) => {
        if (!userList.includes(userId)) {
            // Remove the user from the DOM and the object
            const userDiv = document.getElementById(`user-${userId}`);
            if (userDiv) usersParent.removeChild(userDiv);
            delete users[userId];
        }
    });

    // Add new users from the updated list
    userList.forEach((userId) => {
        if (!users[userId]) {
            // Generate a random position for the new user
            const leftPosition = Math.floor(Math.random() * (80 - 20 + 1)) + 20;

            // Save the user in the object
            
            // Create a new div for the user
            const userDiv = document.createElement('div');
            userDiv.id = `user-${userId}`; // Unique ID for each user
            userDiv.classList.add('user-div'); // ZZZZGeneral class for all user divs
            users[userId] = { 
                id: userId, 
                left: leftPosition, 
                currentState: "idle",
                div: userDiv
            };
            
            if (userId === myId) {
                userDiv.classList.add('current-user'); // Highlight the current user
                userDiv.textContent = 'You';
            } else {
                userDiv.textContent = `User: ${userId}`;
            }

            // Apply the saved position
            userDiv.style.left = `${users[userId].left}%`;

            usersParent.appendChild(userDiv);
        }
    });
});

const states = ["idle", "idle", "idle", "idle", "idle", "right", "left"];


setInterval(() => {
    for (let user in users) {
        const randomNumber = Math.floor(Math.random() * states.length);
        const stateChosen = states[randomNumber];
        if (stateChosen === "right") {
            users[user].div.style.background = 'url("./assets/playerWalkR.gif")'
        }
        else if (stateChosen === "left") {
            users[user].div.style.background = 'url("./assets/playerWalk.gif")'
        }
        else if (stateChosen === "idle") {
            if (users[user].currentState === "left") {
                users[user].div.style.background = 'url("./assets/playerIdle.gif")'
            }
            else if (users[user].currentState === "right") {
                users[user].div.style.background = 'url("./assets/playerIdleR.gif")'
            }
        }
        users[user].currentState = stateChosen
        users[user].div.style.backgroundSize = "cover"
    }
}, 1000);

setInterval(() => {
    for (let user in users) {

        if (users[user].currentState === "left" && users[user].left > 20) {
            users[user].left -= 2;
            users[user].div.style.left = users[user].left + "%"
        }
        else if (users[user].currentState === "right" && users[user].left <80) {
            users[user].left += 2;
            users[user].div.style.left = users[user].left + "%"
        }
        else {
            if (users[user].currentState === "left") {
                users[user].div.style.background = 'url("./assets/playerIdle.gif")'
            }
            else if (users[user].currentState === "right") {
                users[user].div.style.background = 'url("./assets/playerIdleR.gif")'
            }
        }

        users[user].div.style.backgroundSize = "cover"
    }
}, 100);

let campFireState = false;

campFire.addEventListener("click", function () {
    console.log("hellooo")
    if (campFireState) {
        campFireState = false;
        campFire.style.background = 'url("./assets/fireOn.gif")'
    } else {
        campFireState = true;
        campFire.style.background = 'url("./assets/fireOff.gif")'
    }
    campFire.style.backgroundSize = "cover"
})

campFire.addEventListener("click", function () {
    console.log("hellooo")
    if (campFireState) {
        campFireState = false;
        campFire.style.background = 'url("./assets/fireOn.gif")'
    } else {
        campFireState = true;
        campFire.style.background = 'url("./assets/fireOff.gif")'
    }
    campFire.style.backgroundSize = "cover"
})