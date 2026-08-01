import socket
import json

def test_rpc():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect(('127.0.0.1', 9605))
    
    req = {
        "jsonrpc": "2.0",
        "method": "deg.subscribe_events",
        "params": [],
        "id": 1
    }
    s.sendall((json.dumps(req) + '\n').encode('utf-8'))
    
    while True:
        data = s.recv(4096)
        if not data:
            break
        print("Received:", data.decode('utf-8'))

if __name__ == '__main__':
    test_rpc()
