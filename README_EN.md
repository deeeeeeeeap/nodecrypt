# NodeCrypt

🌐 **[中文版 README](README.md)**

## 🚀 Deployment Instructions

### Method 1: One-Click Deploy to Cloudflare Workers

Click the button below for one-click deployment to Cloudflare Workers:
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button?projectName=NodeCrypt)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuaiplus/NodeCrypt)
> Note: This method creates a new project based on the main repository. Future updates to the main repository will not be automatically synchronized.

### Method 2: Auto-Sync Fork and Deploy (Recommended for Long-term Maintenance)
1. First, fork this project to your own GitHub account.
2. Open the Cloudflare Workers console, select "Import from GitHub," and choose your forked repository for deployment.
> This project has built-in auto-sync workflow. After forking, no action is required. Updates from the main repository will automatically sync to your fork, and Cloudflare will automatically redeploy without manual maintenance.

### Method 3: Docker One-Click Deployment (Recommended for Self-hosting)

```bash
docker run -d --name nodecrypt -p 80:80 ghcr.io/shuaiplus/nodecrypt
```

Access http://localhost:80

### Method 4: Local Development Deployment
After cloning the project and installing dependencies, use `npm run dev` to start the development server.
Use `npm run deploy` to deploy to Cloudflare Workers.

Recommended pre-deploy verification:

```bash
npm install
npm run build
npx wrangler deploy --dry-run
npm run smoke:cloudflare
```

`smoke:cloudflare` starts `wrangler dev` locally and uses a browser to verify the key Cloudflare Worker + Durable Object paths: WebSocket connection, live group chat, active-room temporary history, and history cleanup after the room becomes empty.

### Temporary History Boundaries

- Only public text messages are cached; images, files, and private messages are not included in temporary history.
- History is encrypted on the client with a room-name/password-derived key; the Worker and self-hosted server only cache ciphertext.
- New members must use the same room name and password to decrypt text history from the current active room session.
- Temporary history is cleared from memory as soon as every member leaves the room.
- Worker deployments persist each room Durable Object's RSA identity key for stable TOFU verification; this does not include plaintext chat content.

## 📝 Project Introduction

NodeCrypt is a truly end-to-end encrypted chat system that implements a complete zero-knowledge architecture. The entire system design ensures that servers, network intermediaries, and even system administrators cannot access any plaintext message content. All encryption and decryption operations are performed locally on the client side, with the server serving only as a blind relay for encrypted data.

### System Architecture
- **Frontend**: ES6+ modular JavaScript, no framework dependencies
- **Backend**: Cloudflare Workers + Durable Objects
- **Communication**: Real-time bidirectional WebSocket communication
- **Build**: Vite modern build tool

## 🔐 Zero-Knowledge Architecture Design

### Core Principles
- **Server Blind Relay**: The server can never decrypt message content, only responsible for encrypted data relay
- **No Plaintext Message Database**: The server never stores plaintext messages; Workers only persist each room's RSA identity key, and temporary text history is cached as ciphertext while the room is active
- **End-to-End Encryption**: Messages are encrypted from sender to receiver throughout the entire process; no intermediate node can decrypt them
- **Temporary Ciphertext History**: Public text history is encrypted with a room-derived key and cleared when the room becomes empty; images, files, and private messages are not cached as history
- **Anonymous Communication**: Users do not need to register real identities; supports temporary anonymous chat
- **Rich Experience**: Support for sending images and files, with optional themes and languages

### Privacy Protection Mechanisms

- **Real-time Member Notifications**: The room online list is completely transparent; any member joining or leaving will notify all members in real-time
- **Active-Room History**: Users who join with the room password can decrypt temporary text history from the current active room session; history is destroyed when the room becomes empty
- **Private Chat Encryption**: Clicking on a user's avatar can initiate end-to-end encrypted private conversations that are completely invisible to other room members

### Room Password Mechanism

Room passwords serve as **key derivation factors** in end-to-end encryption: `Final Shared Key = SHA256(ECDH_Shared_Key + SHA256(Room Password))`

- **Password Error Isolation**: Rooms with different passwords cannot decrypt each other's messages
- **Server Blind Spot**: The server can never know the room password

### Three-Layer Security System

#### Layer 1: RSA-2048 Server Identity Authentication
- Each room Durable Object keeps a persistent RSA-2048 identity key; clients pin and verify the server public key using TOFU
- Client verifies server public key on connection to prevent man-in-the-middle attacks
- In Worker deployments, each room Durable Object stores RSA private key material in that object's storage/runtime to keep TOFU identity stable; Docker/local mode uses process-local temporary keys

#### Layer 2: ECDH-P384 Key Agreement
- Each client generates independent elliptic curve key pairs (P-384 curve)
- Establishes shared keys through Elliptic Curve Diffie-Hellman key exchange protocol
- Each client has an independent encrypted channel with the server

#### Layer 3: Hybrid Symmetric Encryption
- **Server Communication**: Uses AES-256-CBC to encrypt control messages between client and server
- **Client Communication**: Uses AES-256-GCM to encrypt and authenticate actual chat content between clients
- Each message uses independent initialization vectors (IV)/nonces and authentication tags

## 🔄 Complete Encryption Process

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant O as Other Clients

    Note over C,S: Phase 1: Server Identity Authentication (RSA-2048)
    C->>S: WebSocket Connection
    S->>C: RSA-2048 Public Key
    
    Note over C,S: Phase 2: Client-Server Key Exchange (P-384 ECDH)
    C->>S: P-384 ECDH Public Key
    S->>C: P-384 Public Key + RSA Signature
    Note over C: Verify RSA signature and derive AES-256 key
    Note over S: Derive AES-256 key from P-384 ECDH
    
    Note over C,S: Phase 3: Room Authentication
    C->>S: Join Request (Room Hash, AES-256 encrypted)
    Note over S: Add client to room/channel
    S->>C: Member List (Other client IDs, encrypted)
    
    Note over C,O: Phase 4: Inter-Client Key Exchange (P-384 ECDH)
    Note over C: Generate P-384 key pair for each member
    C->>S: P-384 Public Key Bundle (AES-256 encrypted)
    S->>O: Forward Client C's public key
    O->>S: Return other clients' P-384 public keys
    S->>C: Forward other clients' public keys
    
    Note over C,O: Phase 5: Password-Enhanced Key Derivation
    Note over C: Client Key = SHA256(ECDH_P-384(own private key, other's public key) + SHA256(password))
    Note over O: Client Key = SHA256(ECDH_P-384(own private key, other's public key) + SHA256(password))
    
    Note over C,O: Phase 6: Identity Authentication
    C->>S: Username (AES-GCM encrypted with client key)
    S->>O: Forward encrypted username
    O->>S: Username (AES-GCM encrypted with client key)
    S->>C: Forward encrypted username
    Note over C,O: Both clients now verify each other's identity
    
    Note over C,O: Phase 7: Secure Message Transmission (Double-layer encryption)
    Note over C: 1. AES-GCM encrypt and authenticate(message content)<br/>2. AES-256 encrypt(transport layer wrapper)
    C->>S: Double-layer encrypted message
    Note over S: Decrypt AES-256 transport layer<br/>Extract AES-GCM encrypted data<br/>Cannot decrypt message content
    S->>O: Forward AES-GCM encrypted data
    Note over O: Decrypt AES-256 transport layer<br/>AES-GCM authenticate and decrypt to get message content
```

## 🛠️ Technical Implementation

- **Web Cryptography API**: Native browser P-384 ECDH and AES-GCM implementation
- **aes-js**: Pure JavaScript AES implementation supporting multiple modes
- **js-sha256**: SHA-256 hash algorithm implementation

## 🔬 Security Verification

### Encryption Process Verification
Users can observe the complete encryption and decryption process through browser developer tools to verify that messages are indeed encrypted during transmission.

### Network Traffic Analysis
Network packet capture tools can verify that all WebSocket transmitted data is unreadable encrypted content.

### Code Security Audit
All encryption-related code is completely open source, using standard cryptographic algorithms. Security researchers are welcome to conduct independent audits.

## ⚠️ Security Recommendations

- **Use Strong Room Passwords**: Room passwords directly affect end-to-end encryption strength; complex passwords are recommended
- **Password Confidentiality**: If a room password is leaked, all communication content in that room may be decrypted
- **Use Latest Modern Browsers**: Ensure security and performance of cryptographic APIs

## 🤝 Security Contributions

Security researchers are welcome to report vulnerabilities and conduct security audits. Critical security issues will be fixed within 24 hours.

## 📄 Open Source License

This project uses the ISC open source license.

## ⚠️ Disclaimer

This project is for educational and technical research purposes only and must not be used for any illegal or criminal activities. Users should comply with the relevant laws and regulations of their country and region. The project author assumes no legal responsibility for any consequences arising from the use of this software. Please use this project legally and compliantly.

---

**NodeCrypt** - True End-to-End Encrypted Communication 🔐

*"In the digital age, encryption is the last line of defense for privacy"*
