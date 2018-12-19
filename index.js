const { ProducerStream, ConsumerStream } = require('omnistreams')
const ab2str = require('arraybuffer-to-string')
const str2ab = require('string-to-arraybuffer')

const MESSAGE_TYPE_CREATE_RECEIVE_STREAM = 0
const MESSAGE_TYPE_STREAM_DATA = 1
const MESSAGE_TYPE_STREAM_END = 2
const MESSAGE_TYPE_TERMINATE_SEND_STREAM = 3
const MESSAGE_TYPE_STREAM_REQUEST_DATA = 4


class Peer {
  constructor() {
    this._connections = {}
    this._nextConnectionId = 0
  }

  _getNextConnectionId() {
    const next = this._nextConnectionId
    this._nextConnectionId++
    return next
  }

  createConnection() {
    const connection = new Connection
    const id = this._getNextConnectionId()
    this._connections[id] = connection
    return connection
  }

  createWebsocketConnection(ws) {

    return new Promise(function(resolve, reject) {

      const conn = new Connection

      ws.binaryType = 'arraybuffer'

      ws.onopen = (event) => {

        conn.setSendHandler((message) => {
          ws.send(message)
        })

        ws.onmessage = (rawMessage) => {
          conn.onMessage(rawMessage)
        }

        resolve(conn);
      }

      ws.onerror = (err) => {
        reject(err);
      }
    });
  }
}


class Connection {
  constructor() {

    this._sendStreams = {}
    this._receiveStreams = {}
    this._nextStreamId = 0
  }

  handleMessage(rawMessage) {
    const message = this._parseMessage(rawMessage)

    switch (message.type) {
      case MESSAGE_TYPE_CREATE_RECEIVE_STREAM: {
        console.log("Create stream: " + message.streamId)

        
        const stream = this._makeReceiveStream(message.streamId)

        this._receiveStreams[message.streamId] = stream

        const metadata = JSON.parse(ab2str(message.data))

        this._onStream(stream, metadata)

        break;
      }
      case MESSAGE_TYPE_STREAM_DATA: {
        //console.log("Stream data for stream: " + message.streamId)

        const stream = this._receiveStreams[message.streamId]
        if (stream) {
          stream.receive(message.data)
        }
        else {
          console.error("Invalid stream id: " + message.streamId)
        }

        break;
      }
      case MESSAGE_TYPE_STREAM_END: {
        console.log("Stream ended: " + message.streamId)
        const stream = this._receiveStreams[message.streamId]
        stream.end()
        break;
      }
      case MESSAGE_TYPE_TERMINATE_SEND_STREAM: {
        console.log("Terminate send stream: " + message.streamId)
        const stream = this._sendStreams[message.streamId]
        stream.stop()
        // TODO: properly delete streams when done
        //delete this._sendStreams[message.streamId]
        break;
      }
      case MESSAGE_TYPE_STREAM_REQUEST_DATA: {
        const dv = new DataView(message.data.buffer)
        const bytesRequested = dv.getUint32(0)

        const stream = this._sendStreams[message.streamId]
        stream._requestCallback(bytesRequested)
        break;
      }
      default: {
        console.error("Unsupported message type: " + message.type)
        break;
      }
    }
  }

  setSendHandler(handler) {
    this._send = handler
  }

  onStream(callback) {
    this._onStream = callback
  }

  createStream(metadata) {
    const id = this.nextStreamId()
    const stream = this._makeSendStream(id)
    this._sendStreams[id] = stream
    this._signalCreateStream(id, metadata)
    return stream
  }

  _makeSendStream(id) {
    const sendFunc = (data) => {
      this._streamSend(id, data)
    }

    const endFunc = () => {
      const message = new Uint8Array(2)
      message[0] = MESSAGE_TYPE_STREAM_END
      message[1] = id 
      this._send(message)
    }

    const terminateFunc = () => {
      this._terminateSendStream(id)
    }

    const stream = new SendStream({ sendFunc, endFunc, terminateFunc })
    return stream
  }

  _makeReceiveStream(id) {

    const requestFunc = (numElements) => {
      const message = new DataView(new ArrayBuffer(2 + 8))
      message.setInt8(0, MESSAGE_TYPE_STREAM_REQUEST_DATA)
      message.setInt8(1, id) 

      message.setUint32(2, numElements)
      this._send(message)
    }

    const terminateFunc = () => {
      this._terminateReceiveStream(id)
    }

    const stream = new ReceiveStream({ requestFunc, terminateFunc })
    return stream
  }

  nextStreamId() {
    const next = this._nextStreamId
    this._nextStreamId++
    return next
  }

  _signalCreateStream(streamId, metadata) {

    const mdString = JSON.stringify(metadata)
    const mdArray = new Uint8Array(str2ab(mdString))

    const signallingLength = 2

    // TODO: allow stream ids to go higher than 255, or at least reuse them
    const message = new Uint8Array(signallingLength + mdArray.byteLength)
    message[0] = MESSAGE_TYPE_CREATE_RECEIVE_STREAM
    message[1] = streamId
    message.set(mdArray, signallingLength)
    
    this._send(message)
  }

  _streamSend(streamId, data) {
    
    const signallingLength = 2
    const message = new Uint8Array(signallingLength + data.byteLength)
    message[0] = MESSAGE_TYPE_STREAM_DATA
    message[1] = streamId 
    message.set(data, signallingLength)
    this._send(message)
  }

  _terminateSendStream(streamId) {
    console.log("terminate send stream: " + streamId)
  }

  _terminateReceiveStream(streamId) {
    console.log("terminate receive stream: " + streamId)
    const message = new Uint8Array(2)
    message[0] = MESSAGE_TYPE_TERMINATE_SEND_STREAM
    message[1] = streamId

    console.log("send it")
    console.log(message)
    this._send(message)
  }

  _parseMessage(rawMessage) {
    const byteMessage = new Uint8Array(rawMessage)
    const message = {}
    message.type = byteMessage[0]
    message.streamId = byteMessage[1]
    message.data = byteMessage.slice(2)
    return message
  }

  _isLocalStream(streamId) {
    return this._sendStreams[streamId] !== undefined
  }
}


class SendStream extends ConsumerStream {
  constructor({ sendFunc, endFunc, terminateFunc, bufferSize, chunkSize }) {
    super()

    this._send = sendFunc
    this._end = endFunc
    this._terminate = terminateFunc
    this._bufferSize = bufferSize ? bufferSize : 2*1024*1024
    this._chunkSize = chunkSize ? chunkSize : 1024*1024
  }

  _write(data) {
    if (this._finished) {
      return
    }

    data = new Uint8Array(data)
    //this._demand--
    this.send(data)

    //const attemptSend = () => {

    //  if (data.length <= this._chunkSize) {
    //    this.send(data)
    //  }
    //  else {
    //    const chunk = new Uint8Array(data.buffer, 0, this._chunkSize) 
    //    this.send(chunk)
    //    data = new Uint8Array(data.buffer, this._chunkSize, data.length - this._chunkSize)
    //    attemptSend()
    //  }
    //}

    //attemptSend()
  }

  end() {
    this._finished = true
    this._end()
    this._endCallback()
  }

  send(data) {
    const array = new Uint8Array(data)
    this._send(array)
  }

  terminate() {
    this._terminate()
  }

  stop() {
    if (this._chunker) {
      this._chunker.cancel()
    }
    this._terminateCallback()
  }

  onFlushed(callback) {
    this._onFlushed = callback
  }

  onTerminateOld(callback) {
    this._terminateCallback = callback
  }
}


class ReceiveStream extends ProducerStream {

  constructor({ requestFunc, terminateFunc }) {
    super()

    this._request = requestFunc
    this.onTerminate(terminateFunc)
    this._totalBytesReceived = 0
    this._buffer = new Uint8Array(2*1024*1024)
    //this._request(this._buffer.byteLength)
    this._offset = 0
  }

  _demandChanged(numElements) {
    if (this._terminated) {
      return
    }

    //console.log("request", numElements)
    this._request(numElements)
    //this.flush()
  }

  end() {
    this._endCallback()
  }

  receive(data) {
    if (this._terminated) {
      return
    }

    //console.log("receive", data.byteLength)
    //this._demand--
    this._dataCallback(data)
    //console.log(this._offset, data)
    //if (this._offset + data.byteLength > this._buffer.byteLength) {
    //  throw "Buffer overflow"
    //}

    //this._buffer = new Uint8Array(this._buffer.buffer, this._offset, data.byteLength)
    //this._buffer.set(data, this._offset)
    //console.log(this._buffer)
    //this._offset += data.byteLength
    //this.flush()

    //this._dataCallback(data)
  }

  //flush() {

  //  console.log(this._demand, this._offset)
  //  if (this._demand > 0 && this._offset > 0) {
  //    const sendSize = this._offset > this._demand ? this._demand : this._offset
  //    const data = new Uint8Array(this._buffer.buffer, 0, sendSize)
  //    console.log("here")
  //    console.log(data)
  //    this._demand -= sendSize
  //    this._buffer = new Uint8Array(this._buffer.buffer, sendSize)
  //    this._offset -= sendSize

  //    console.log("send:", data.byteLength)
  //    this._dataCallback(data)
  //  }
  //}

  //request(numElements) {
  //  this._request(numElements)
  //}
}

module.exports = {
  Peer,
}
