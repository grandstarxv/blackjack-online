const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const SUITS = ["♠","♥","♦","♣"];
const RANKS = [
  ["A",11],["2",2],["3",3],["4",4],["5",5],["6",6],["7",7],["8",8],
  ["9",9],["10",10],["J",10],["Q",10],["K",10]
];

function deck() {
  const d=[];
  for (const s of SUITS) for (const [r,v] of RANKS) d.push({s,r,v});
  return d.sort(()=>Math.random()-0.5);
}
function value(hand) {
  let total=hand.reduce((a,c)=>a+c.v,0), aces=hand.filter(c=>c.r==="A").length;
  while(total>21 && aces--) total-=10;
  return total;
}
function publicRoom(room) {
  return {
    players: [...room.players.values()].map(p=>({
      id:p.id,name:p.name,chips:p.chips,bet:p.bet,hand:p.hand,done:p.done
    })),
    dealer: { hand: room.dealer.hand, value: room.phase==="playing" ? null : value(room.dealer.hand) },
    phase: room.phase,
    turn: room.turn,
    dealerIndex: room.dealerIndex,
    message: room.message
  };
}
function emit(room) { io.to(room.code).emit("state", publicRoom(room)); }

function startRound(room) {
  if (room.players.size === 0) return;
  room.deck = deck();
  room.dealer.hand = [room.deck.pop(), room.deck.pop()];
  const ps=[...room.players.values()];
  ps.forEach(p=>{
    p.hand=[room.deck.pop(),room.deck.pop()];
    p.done=false;
  });
  room.phase="betting";
  room.turn=null;
  room.message="ベット額を決めてください";
  emit(room);
}

function beginPlaying(room) {
  const ps=[...room.players.values()];
  const eligible=ps.filter(p=>p.bet>0 && p.chips>=0);
  if (!eligible.length) { room.message="誰かがベットしてから開始してください"; emit(room); return; }
  room.phase="playing";
  room.message="";
  const idx=ps.findIndex(p=>p.bet>0);
  room.turn=ps[idx].id;
  emit(room);
}

function finishRound(room) {
  room.phase="dealer";
  while(value(room.dealer.hand)<17) room.dealer.hand.push(room.deck.pop());
  const dv=value(room.dealer.hand);
  for(const p of room.players.values()){
    if(p.bet<=0) continue;
    const pv=value(p.hand);
    let payout=0;
    if(pv>21) payout=0;
    else if(dv>21 || pv>dv) payout=p.bet*2;
    else if(pv===dv) payout=p.bet;
    if(payout) p.chips += payout;
    p.bet=0; p.done=true;
  }
  room.message=`ディーラー ${dv}。結果を確認してください`;
  emit(room);
}

function nextTurn(room) {
  const ps=[...room.players.values()];
  const start=ps.findIndex(p=>p.id===room.turn);
  for(let i=1;i<=ps.length;i++){
    const p=ps[(start+i)%ps.length];
    if(p.bet>0 && !p.done){ room.turn=p.id; emit(room); return; }
  }
  finishRound(room);
}

io.on("connection", socket=>{
  socket.on("join", ({code,name})=>{
    code=(code||"").trim().toUpperCase();
    name=(name||"プレイヤー").trim().slice(0,16);
    if(!code) return socket.emit("errorMsg","ルームコードを入力してください");
    let room=rooms.get(code);
    if(!room){
      room={code,players:new Map(),dealerIndex:0,deck:[],dealer:{hand:[]},phase:"lobby",turn:null,message:"ルームを作成しました"};
      rooms.set(code,room);
    }
    if(room.players.size>=8) return socket.emit("errorMsg","このルームは満員です");
    room.players.set(socket.id,{id:socket.id,name,chips:1000,bet:0,hand:[],done:false});
    socket.join(code);
    socket.data.room=code;
    emit(room);
  });

  socket.on("bet", amount=>{
    const room=rooms.get(socket.data.room); if(!room || room.phase!=="betting") return;
    const p=room.players.get(socket.id); amount=Math.floor(Number(amount));
    if(!p || !Number.isFinite(amount) || amount<1 || amount>p.chips) return;
    p.chips-=amount; p.bet=amount; p.done=false;
    if([...room.players.values()].every(x=>x.bet>0)) beginPlaying(room);
    else {room.message=`${p.name} がベットしました`; emit(room);}
  });

  socket.on("hit", ()=>{
    const room=rooms.get(socket.data.room), p=room?.players.get(socket.id);
    if(!room || room.phase!=="playing" || room.turn!==socket.id || !p) return;
    p.hand.push(room.deck.pop());
    if(value(p.hand)>=21){ p.done=true; nextTurn(room); } else emit(room);
  });

  socket.on("stand", ()=>{
    const room=rooms.get(socket.data.room), p=room?.players.get(socket.id);
    if(!room || room.phase!=="playing" || room.turn!==socket.id || !p) return;
    p.done=true; nextTurn(room);
  });

  socket.on("newRound", ()=>{
    const room=rooms.get(socket.data.room); if(!room) return;
    const ps=[...room.players.values()];
    room.dealerIndex=(room.dealerIndex+1)%Math.max(ps.length,1);
    startRound(room);
  });

  socket.on("disconnect", ()=>{
    const code=socket.data.room, room=rooms.get(code); if(!room) return;
    room.players.delete(socket.id);
    if(!room.players.size) rooms.delete(code); else emit(room);
  });
});

server.listen(process.env.PORT||3000, ()=>console.log("Blackjack server running"));
