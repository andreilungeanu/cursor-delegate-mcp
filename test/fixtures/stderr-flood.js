// Writes 640KB to stderr — ten times AcpClient's 64KB cap — then stays alive, so the ring buffer
// can be read without racing the exit handler, which reads stderrBuffer itself.
const CHUNK = "x".repeat(20000);

process.stderr.write("FLOOD-START");
for (let i = 0; i < 32; i++) process.stderr.write(CHUNK);
process.stderr.write("FLOOD-END\n");
setInterval(() => {}, 1000);
