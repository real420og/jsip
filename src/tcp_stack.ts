import { config } from "./config";
import { IPHdr, IPAddr, IPPROTO } from "./ip";
import { TCP_FLAGS, TCPPkt } from "./tcp";
import { registerIpHandler } from "./ip_stack";
import { sendPacket } from "./wssend";

export type TCPListener = (data: Uint8Array, tcpConn: TCPConn) => void;

const tcpConns: { [key: string]: TCPConn } = {};
const tcpListeners: { [key: number]: TCPListener } = {
	7: (data, tcpConn) => { // ECHO
		const d = new Uint8Array(data);
		if (data.byteLength === 1 && d[0] === 10) {
			tcpConn.close();
		} else {
			tcpConn.send(d);
		}
	},
};

// Public API:
// *connect / *listen / send / close / kill

export const enum TCP_CBTYPE {
	SENT = 0,
	ACKD = 1,
};

const enum TCP_STATE {
	CLOSED = 0,
	SYN_SENT = 1,
	SYN_RECEIVED = 2,
	FIN_WAIT_1 = 3,
	FIN_WAIT_2 = 4,
	CLOSING = 5,
	TIME_WAIT = 6,
	CLOSE_WAIT = 7,
	LAST_ACK = 8,
	ESTABLISHED = 9,
};

const TCP_ONLY_SEND_ON_PSH = false;

const TCP_FLAG_INCSEQ = ~(TCP_FLAGS.PSH | TCP_FLAGS.ACK);

export type TCPONAckHandler = (type: TCP_CBTYPE) => void;
export type TCPConnectHandler = (res: boolean, conn?: TCPConn) => void;
export type TCPDisconnectHandler = (conn: TCPConn) => void;

type WBufferEntry = {
	close?: boolean;
	data?: Uint8Array;
	psh?: boolean;
	cb?: TCPONAckHandler;
};

export class TCPConn {
	private state = TCP_STATE.CLOSED;
	private daddr?: IPAddr;
	private sport = 0;
	private dport = 0;
	private lseqno?: number;
	private rseqno?: number;
	private wnd = 65535;
	//private lastack?: number;
	private wbuffers: WBufferEntry[] = [];
	private rbuffers: Uint8Array[] = [];
	private rbufferlen = 0;
	//private rlastack = false;
	private wlastack = false;
	private wlastsend = 0;
	private wretrycount = 0;
	private rlastseqno?: number;
	private onack: { [key: number]: [TCPONAckHandler] } = {};
	private mss = config.mss;
	private	connect_cb?: TCPConnectHandler;
	private handler?: TCPListener;
	private _id?: string;
	public disconnect_cb?: TCPDisconnectHandler;

	private _lastIp?: IPHdr;
	private _lastTcp?: TCPPkt;
	private lastack_ip?: IPHdr;
	private lastack_tcp?: TCPPkt;

	constructor(handler?: TCPListener) {
		this.handler = handler;
	}

	_makeIp(df = false) {
		const ip = new IPHdr();
		ip.protocol = IPPROTO.TCP;
		ip.saddr = config.ourIp;
		ip.daddr = this.daddr;
		ip.df = df;
		return ip;
	}

	_makeTcp() {
		const tcp = new TCPPkt();
		tcp.window_size = this.wnd;
		tcp.dport = this.dport;
		tcp.sport = this.sport;
		let incSeq = false;
		if (this.lseqno === undefined) {
			this.lseqno = Math.floor(Math.random() * (1 << 30));
			tcp.setFlag(TCP_FLAGS.SYN);
			incSeq = true;
			tcp.fillMSS();
		}
		tcp.seqno = this.lseqno;
		if (incSeq) {
			this.incLSeq(1);
		}
		if (this.rseqno !== undefined) {
			tcp.ackno = this.rseqno;
			tcp.setFlag(TCP_FLAGS.ACK);
			//this.rlastack = true;
		}
		return tcp;
	}

	delete() {
		this.state = TCP_STATE.CLOSED;
		this.wbuffers = [];
		this.rbuffers = [];
		if (this.disconnect_cb) {
			this.disconnect_cb(this);
			this.disconnect_cb = undefined;
		}
		this._connectCB(false);
		delete tcpConns[this._id!];
	}

	kill() {
		const ip = this._makeIp(true);
		const tcp = this._makeTcp();
		tcp.flags = 0;
		tcp.setFlag(TCP_FLAGS.RST);
		sendPacket(ip, tcp);
		this.delete();
	}

	addOnAck(cb?: TCPONAckHandler) {
		if (!cb) {
			return;
		}

		cb(TCP_CBTYPE.SENT);

		const ack = this.lseqno;
		const onack = this.onack[ack!];
		if (!onack) {
			this.onack[ack!] = [cb];
			return;
		}
		onack.push(cb);
	}

	close(cb?: TCPONAckHandler) {
		if (!this.wlastack || this.state !== TCP_STATE.ESTABLISHED) {
			this.wbuffers.push({ close: true, cb });
			return;
		}

		const ip = this._makeIp(true);
		const tcp = this._makeTcp();
		tcp.setFlag(TCP_FLAGS.FIN);
		this.sendPacket(ip, tcp);
		this.incLSeq(1);

		this.addOnAck(cb);
	}

	sendPacket(ipHdr: IPHdr, tcpPkt: TCPPkt) {
		this._lastIp = ipHdr;
		this._lastTcp = tcpPkt;
		sendPacket(ipHdr, tcpPkt);
		this.wlastack = false;
		this.wlastsend = Date.now();
	}

	incRSeq(inc: number) {
		this.rseqno = (this.rseqno! + inc) & 0xFFFFFFFF;
	}

	incLSeq(inc: number) {
		this.lseqno = (this.lseqno! + inc) & 0xFFFFFFFF;
	}

	cycle() {
		if (!this.wlastack && this._lastTcp && this.wlastsend < Date.now() - 1000) {
			if (this.wretrycount > 3) {
				this.kill();
				return;
			}
			if (this._lastIp) {
				sendPacket(this._lastIp, this._lastTcp);
			}
			this.wretrycount++;
		}
	}

	send(data: Uint8Array, cb?: TCPONAckHandler) {
		if (!data || !data.byteLength) {
			return;
		}

		const isReady = this.wlastack && this.state === TCP_STATE.ESTABLISHED;

		let psh = true;
		if (data.byteLength > this.mss) {
			const first = data.slice(0, this.mss);
			if (!isReady) {
				this.wbuffers.push({ data: first, psh: false });
			}
			for (let i = this.mss; i < data.byteLength; i += this.mss) {
				this.wbuffers.push({ data: data.slice(i, i + this.mss), psh: false });
			}
			const last = this.wbuffers[this.wbuffers.length - 1];
			if (cb) {
				last.cb = cb;
			}
			last.psh = true;
			if (!isReady) {
				return;
			}
			data = first;
			cb = undefined;
			psh = false;
		}

		if (!isReady) {
			this.wbuffers.push({ data, cb, psh: true });
			return;
		}

		this._send(data, psh, cb);
	}

	_connectCB(res: boolean) {
		if (this.connect_cb) {
			this.connect_cb(res, this);
			this.connect_cb = undefined;
		}
	}

	_send(data?: Uint8Array, psh?: boolean, cb?: TCPONAckHandler) {
		const ip = this._makeIp();
		const tcp = this._makeTcp();
		tcp.data = data;
		if (psh) {
			tcp.setFlag(TCP_FLAGS.PSH);
		}
		this.sendPacket(ip, tcp);
		this.incLSeq(data ? data.byteLength : 0);
		this.addOnAck(cb);
	}

	gotPacket(_ipHdr: IPHdr, tcpPkt: TCPPkt) {
		if (this.state === TCP_STATE.CLOSED) {
			return this.kill();
		}

		if (this.rlastseqno !== undefined && tcpPkt.seqno <= this.rlastseqno) {
			if (this.lastack_tcp && this.lastack_ip) {
				sendPacket(this.lastack_ip, this.lastack_tcp);
			}
			return;
		}

		let lseqno = this.lseqno;
		let rseqno = this.rseqno;

		if (tcpPkt.hasFlag(TCP_FLAGS.SYN)) {
			//this.rlastack = false;
			if (this.state === TCP_STATE.SYN_SENT || this.state === TCP_STATE.SYN_RECEIVED) {
				this.rseqno = tcpPkt.seqno;

				this.incRSeq(1);
				const ip = this._makeIp(true);
				const tcp = this._makeTcp();
				if (this.state === TCP_STATE.SYN_RECEIVED) {
					this.sendPacket(ip, tcp);
				} else {
					sendPacket(ip, tcp);
				}

				rseqno = this.rseqno;
				lseqno = this.lseqno;

				this.state = TCP_STATE.ESTABLISHED;
				this._connectCB(true);
			} else {
				throw new Error('Unexpected SYN');
			}
		} else {
			if (this.rseqno === undefined) {
				throw new Error('Wanted SYN, but got none');
			}

			if (tcpPkt.seqno !== this.rseqno) {
				throw new Error('Invalid sequence number');
			}

			if (tcpPkt.hasFlag(TCP_FLAGS.RST)) {
				//this.rlastack = false;
				this.delete();
				return;
			}

			if (tcpPkt.data && tcpPkt.data.byteLength > 0) {
				this.rlastseqno = rseqno;
				//this.rlastack = false;
				this.incRSeq(tcpPkt.data.byteLength);
				const ip = this._makeIp(true);
				const tcp = this._makeTcp();
				sendPacket(ip, tcp);
				this.lastack_ip = ip;
				this.lastack_tcp = tcp;

				if (TCP_ONLY_SEND_ON_PSH) {
					this.rbufferlen += tcpPkt.data.byteLength;
					this.rbuffers.push(tcpPkt.data);
					if (tcpPkt.hasFlag(TCP_FLAGS.PSH)) {
						const all = new ArrayBuffer(this.rbufferlen);
						const a8 = new Uint8Array(all);
						let pos = 0;
						for (let i = 0; i < this.rbuffers.length; i++) {
							const b8 = new Uint8Array(this.rbuffers[i]);
							for (let j = 0; j < b8.length; j++) {
								a8[pos + j] = b8[j];
							}
							pos += b8.length;
						}
						this.rbuffers = [];
						if (this.handler) {
							this.handler(new Uint8Array(all), this);
						}
					}
				} else if (this.handler) {
					this.handler(tcpPkt.data, this);
				}
			}

			if ((tcpPkt.flags & TCP_FLAG_INCSEQ) !== 0) { // not (only) ACK set?
				this.incRSeq(1);
			}

			if (tcpPkt.mss !== -1) {
				this.mss = tcpPkt.mss;
			}
		}

		if (tcpPkt.hasFlag(TCP_FLAGS.ACK)) {
			if (tcpPkt.ackno === lseqno) {
				const onack = this.onack[tcpPkt.ackno];
				if (onack) {
					onack.forEach(cb => cb(TCP_CBTYPE.ACKD));
					delete this.onack[tcpPkt.ackno];
				}

				this.wlastack = true;
				this.wretrycount = 0;
				if (this.state === TCP_STATE.CLOSING || this.state === TCP_STATE.LAST_ACK) {
					this.delete();
				} else {
					const next = this.wbuffers.shift();
					if (next) {
						this._send(next.data, next.psh ? next.psh : false, next.cb);
					}
				}
			} else {
				throw new Error('Wrong ACK');
			}
		}

		if (tcpPkt.hasFlag(TCP_FLAGS.FIN)) {
			//this.rlastack = false;
			const ip = this._makeIp(true);
			const tcp = this._makeTcp();
			switch (this.state) {
				case TCP_STATE.FIN_WAIT_1:
				case TCP_STATE.FIN_WAIT_2:
					sendPacket(ip, tcp); // ACK it
					if (!tcpPkt.hasFlag(TCP_FLAGS.ACK)) {
						this.state = TCP_STATE.CLOSING;
					} else {
						this.delete();
					}
					break;
				case TCP_STATE.CLOSING:
				case TCP_STATE.LAST_ACK:
					this.delete();
					sendPacket(ip, tcp);
					this.incLSeq(1);
					break;
				default:
					this.state = TCP_STATE.LAST_ACK;
					tcp.setFlag(TCP_FLAGS.FIN);
					sendPacket(ip, tcp);
					this.incLSeq(1);
					break;
			}
		}
	}

	accept(ipHdr: IPHdr, tcpPkt: TCPPkt) {
		this.state =  TCP_STATE.SYN_RECEIVED;
		this.daddr = ipHdr.saddr;
		this.dport = tcpPkt.sport;
		this.sport = tcpPkt.dport;
		this._id = this.toString();
		tcpConns[this._id] = this;
		this.gotPacket(ipHdr, tcpPkt);
	}

	connect(dport: number, daddr: IPAddr, cb: TCPConnectHandler, dccb?: TCPDisconnectHandler) {
		this.state = TCP_STATE.SYN_SENT;
		this.daddr = daddr;
		this.dport = dport;
		this.connect_cb = cb;
		this.disconnect_cb = dccb;
		do {
			this.sport = 4097 + Math.floor(Math.random() * 61347);
			this._id = this.toString();
		} while(tcpConns[this._id] || tcpListeners[this.sport]);
		tcpConns[this._id] = this;

		const ip = this._makeIp(true);
		const tcp = this._makeTcp();
		this.sendPacket(ip, tcp);
	}

	toString() {
		return `${this.daddr}|${this.sport}|${this.dport}`;
	}
}

function tcpGotPacket(data: ArrayBuffer, offset: number, len: number, ipHdr: IPHdr) {
	const tcpPkt = TCPPkt.fromPacket(data, offset, len, ipHdr);

	const id = `${ipHdr.saddr}|${tcpPkt.dport}|${tcpPkt.sport}`;
	if (tcpConns[id]) {
		return tcpConns[id].gotPacket(ipHdr, tcpPkt);
	}

	if (tcpPkt.hasFlag(TCP_FLAGS.SYN) && !tcpPkt.hasFlag(TCP_FLAGS.ACK) && tcpListeners[tcpPkt.dport]) {
		const conn = new TCPConn(tcpListeners[tcpPkt.dport]);
		return conn.accept(ipHdr, tcpPkt);
	}
}

export function tcpListen(port: number, func: TCPListener) {
	if (typeof port !== 'number' || port < 1 || port > 65535) {
		return false;
	}

	if  (tcpListeners[port]) {
		return false;
	}

	tcpListeners[port] = func;
	return true;
}

export function tcpCloseListener(port: number) {
	if (typeof port !== 'number' || port < 1 || port > 65535) {
		return false;
	}

	if (port === 7) {
		return false;
	}

	delete tcpListeners[port];
	return true;
}

export function tcpConnect(ip: IPAddr, port: number, func: TCPListener, cb: TCPConnectHandler, dccb?: TCPDisconnectHandler) {
	if (typeof port !== 'number' || port < 1 || port > 65535) {
		return false;
	}

	const conn = new TCPConn(func);
	conn.connect(port, ip, cb, dccb);
	return conn;
}

setInterval(1000, () => {
	for (const id in tcpConns) {
		const conn = tcpConns[id];
		conn.cycle();
	}
});

registerIpHandler(IPPROTO.TCP, tcpGotPacket);
