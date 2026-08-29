import net from "node:net";
net.connect(443, "example.com");
process.env.HTTP_PROXY = "http://example.com:8080";
