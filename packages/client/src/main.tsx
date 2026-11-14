import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { beats, cardLabel, cardOf, comboLabel, interpret, isWild, rankLabel, sortHand, suitLabel, validReturnCards, validTributeCards, type CardId, type Play, type Seat } from '@guandan/engine';
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_MAX_LENGTH, DEAL_ANIMATION, DEFAULT_ROOM_ID, type ChatMessage, type Ack, type ClientToServerEvents, type ServerToClientEvents, type RoomSnapshot, type GameUpdate, type SessionInfo, type ClientGameAction } from '@guandan/protocol';
import { displayPlayCards, trickPassesBySeat, trickPlaysBySeat } from './trickPlays.ts';
import { groupHand, layoutHand } from './handLayout.ts';
import { TributeInfo } from './TributeInfo.tsx';
import { ReadyButton } from './ReadyButton.tsx';
import './style.css';

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3001` : location.origin), { autoConnect: false, auth: { token: localStorage.getItem('guandan-token') || undefined } });
function cardRowStyle(count: number) {
 return { gridTemplateColumns: count > 1 ? `repeat(${count - 1}, minmax(0, 1fr)) var(--card-width)` : 'var(--card-width)', width: `min(100%, calc(${Math.max(count - 1, 0) * 26}px + var(--card-width)))`, '--card-count': count };
}
function CardCorner({ card, wild = false, compactJoker = false }: { card: CardId; wild?: boolean; compactJoker?: boolean }) {
 const { rank, suit } = cardOf(card);
 return <span className={`card-corner suit-${suit}`} aria-hidden="true"><span className={`card-rank ${suit === 'J' ? 'joker' : rank === 10 ? 'ten' : ''}`}>{suit === 'J' ? (compactJoker ? <>JK<span className="compact-joker-last">R</span></> : 'JOKER') : rankLabel(rank)}</span>{suit !== 'J' && <span className="card-suit">{suitLabel(suit)}</span>}{wild && <span className="card-wild">配</span>}</span>;
}
function ChatPanel({ roomId, playerId, connected, open, onUnread, onTouchStart, onTouchEnd, onTouchCancel }: { roomId: string; playerId: string; connected: boolean; open: boolean; onUnread: (roomId: string) => void; onTouchStart: (event: React.TouchEvent) => void; onTouchEnd: (event: React.TouchEvent) => void; onTouchCancel: () => void }) {
 const [messages,setMessages]=useState<ChatMessage[]>([]), [draft,setDraft]=useState(''), [error,setError]=useState(''), [sending,setSending]=useState(false);
 const endRef=useRef<HTMLDivElement>(null);
 const openRef=useRef(open); openRef.current=open;
 useEffect(()=>{
  let active=true, initialized=false;
  const known=new Set<string>();
  const onMessage=(message:ChatMessage)=>{
   if(message.roomId!==roomId || known.has(message.id))return;
   known.add(message.id);
   if(!openRef.current && message.playerId!==playerId)onUnread(roomId);
   setMessages(old=>old.some(m=>m.id===message.id)?old:[...old,message].slice(-CHAT_HISTORY_LIMIT));
  };
  const sync=()=>socket.emit('chat:history',result=>{
   if(!active || !result.ok)return;
   if(initialized && !openRef.current && result.data.some(message=>!known.has(message.id) && message.playerId!==playerId))onUnread(roomId);
   for(const message of result.data)known.add(message.id);
   initialized=true;
   setMessages(old=>[...result.data,...old.filter(message=>!result.data.some(item=>item.id===message.id))].slice(-CHAT_HISTORY_LIMIT));
  });
  socket.on('chat:message',onMessage); socket.on('connect',sync); if(socket.connected)sync();
  return()=>{active=false;socket.off('chat:message',onMessage);socket.off('connect',sync);};
 },[roomId,playerId,onUnread]);
 useEffect(()=>{if(open)endRef.current?.scrollIntoView({block:'nearest'});},[messages,open]);
 useEffect(()=>{if(!connected)setSending(false);},[connected]);
 function send(event:React.FormEvent){
  event.preventDefault(); const text=draft.trim(); if(!text || !connected || sending)return;
  setSending(true); setError('');
  socket.timeout(5000).emit('chat:send',{text},(err,result)=>{
   setSending(false);
   if(err){setError('发送失败，请重试');return;}
   if(!result.ok){setError(result.error.message);return;}
   setDraft(current=>current.trim()===text?'':current);
  });
 }
 return <aside id="room-chat" className={`chat-panel ${open?'':'chat-closed'}`} aria-label="房间群聊" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={onTouchCancel}>
  <div className="chat-messages" role="log" aria-label="聊天消息" aria-live="polite">{messages.length===0&&<p className="chat-empty">还没有消息，和牌友打个招呼吧。</p>}{messages.map(message=><div className={`chat-message ${message.playerId===playerId?'chat-mine':''}`} key={message.id}><div className="chat-meta"><strong>{message.playerId===playerId?'你':message.nickname}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div><p>{message.text}</p></div>)}<div ref={endRef}/></div>
  <form className="chat-compose" onSubmit={send}><div><input id="chat-input" aria-label="发送消息" value={draft} maxLength={CHAT_MESSAGE_MAX_LENGTH} onChange={e=>setDraft(e.target.value)} placeholder="输入消息…" autoComplete="off"/><button className="primary" type="submit" aria-label="发送消息" disabled={!connected||!draft.trim()||sending}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 5v4a4 4 0 0 1-4 4H4m0 0 4-4m-4 4 4 4"/></svg></button></div>{error&&<p role="alert">{error}</p>}{!connected&&<p>正在重连，暂时无法发送</p>}</form>
 </aside>;
}
function App() {
 const [session,setSession]=useState<SessionInfo|null>(null), [room,setRoom]=useState<RoomSnapshot|null>(null), [game,setGame]=useState<GameUpdate|null>(null), [selected,setSelected]=useState<CardId[]>([]), [choice,setChoice]=useState(0), [nickname,setNickname]=useState(''), [roomId,setRoomId]=useState(DEFAULT_ROOM_ID), [error,setError]=useState(''), [connected,setConnected]=useState(false);
 const [sixRowLayout,setSixRowLayout]=useState(()=>localStorage.getItem('guandan-portrait-layout')==='six-rows');
 useEffect(()=>{ const onConnect=()=>{setConnected(true); socket.emit('game:sync',r=>{if(r.ok && r.data) setGame(r.data);});}; const onDisconnect=()=>setConnected(false); const onSession=(s:SessionInfo)=>{localStorage.setItem('guandan-token',s.token);socket.auth={token:s.token};setSession(s);setNickname(s.nickname);setRoom(old=>old?.roomId===s.roomId?old:null);setGame(old=>old?.roomId===s.roomId?old:null);}; const onRoom=(r:RoomSnapshot)=>setRoom(r); const onLeft=()=>{setRoom(null);setGame(null);setSelected([]);setUnreadRoom(null);}; const onGame=(g:GameUpdate)=>{setGame(old=> old && old.roomId===g.roomId && old.version>g.version ? old : g);setSelected([]);setChoice(0);}; socket.on('connect',onConnect);socket.on('disconnect',onDisconnect);socket.on('session',onSession);socket.on('room:state',onRoom);socket.on('room:left',onLeft);socket.on('game:update',onGame);socket.connect();return()=>{socket.off('connect',onConnect);socket.off('disconnect',onDisconnect);socket.off('session',onSession);socket.off('room:state',onRoom);socket.off('room:left',onLeft);socket.off('game:update',onGame);socket.disconnect();}; },[]);
 const [chatOpen,setChatOpen]=useState(()=>window.matchMedia('(min-width: 901px) and (min-height: 551px)').matches);
 const [unreadRoom,setUnreadRoom]=useState<string|null>(null);
 const swipeStart=useRef<{x:number;y:number}|null>(null);
 function openChat(open:boolean){setChatOpen(open);if(open)setUnreadRoom(null);}
 function startChatSwipe(event:React.TouchEvent){
  if(event.touches.length!==1 || (event.target instanceof Element && event.target.closest('input, textarea, select'))) {swipeStart.current=null;return;}
  const touch=event.touches[0]!;swipeStart.current={x:touch.clientX,y:touch.clientY};
 }
 function endChatSwipe(event:React.TouchEvent){
  const start=swipeStart.current;swipeStart.current=null;
  if(!start || event.changedTouches.length!==1)return;
  const touch=event.changedTouches[0]!, dx=touch.clientX-start.x, dy=touch.clientY-start.y;
  if(Math.abs(dx)<60 || Math.abs(dx)<Math.abs(dy)*1.3)return;
  if(!chatOpen && dx<0)openChat(true);
  else if(chatOpen && dx>0)openChat(false);
 }
 const [dealClock,setDealClock]=useState<{startedAt:number; elapsed:number}|null>(null);
 useEffect(()=>{
  const deal=game?.dealing; if(!deal){setDealClock(null);return;}
  const receivedAt=performance.now();
  const tick=()=>setDealClock({startedAt:deal.startedAt,elapsed:Math.max(0,deal.serverNow-deal.startedAt+performance.now()-receivedAt)});
  tick(); const timer=window.setInterval(tick,50); return()=>window.clearInterval(timer);
 },[game?.dealing?.startedAt,game?.dealing?.serverNow]);
 const ack=(r:Ack<any>)=>{if(!r.ok)setError(r.error.message);else setError('');};
 const view=game?.view;
 const displayedHandResult=view && (view.phase==='handOver'||view.phase==='matchOver') ? view.lastResult : null;
 const displayedLevel=displayedHandResult?.level ?? view?.level;
 const displayedLevelTeam=displayedHandResult ? displayedHandResult.levelTeam : view?.levelTeam;
 const dealing=game?.dealing ?? null;
 const dealElapsed=dealing ? (dealClock?.startedAt===dealing.startedAt ? dealClock.elapsed : Math.max(0,dealing.serverNow-dealing.startedAt)) : 0;
 const shuffling=!!dealing && dealElapsed<DEAL_ANIMATION.shuffleMs;
 const dealtCount=dealing ? Math.min(DEAL_ANIMATION.cardsPerPlayer,Math.max(0,Math.floor((dealElapsed-DEAL_ANIMATION.shuffleMs)/DEAL_ANIMATION.cardMs))) : 0;
 const visibleHand=view ? (dealing ? view.myHand.slice(0,dealtCount) : view.myHand) : [];
 const handKey=visibleHand.join(',');
 const handLayout=useMemo(()=>{
  if(!view)return layoutHand([]);
  const cards=handKey ? handKey.split(',').map(Number) : [];
  const groups=dealing ? sortHand(cards,view.level).map(card=>({label:'',cards:[card]})) : groupHand(cards,view.level);
  return layoutHand(groups);
 },[handKey,view?.level,!!dealing]);
 const seatPlays=trickPlaysBySeat(view?.trick ?? null,view?.phase==='playing');
 const seatPasses=trickPassesBySeat(view?.trick ?? null,view?.phase==='playing');
 const plays=useMemo(()=>{if(!view || !selected.length || view.myDuty!=='play')return []; const last=view.trick?.lastPlay?.play.combo; return interpret(selected,view.level,view.config).filter(p=>!last || beats(p.combo,last));},[view,selected]);
 const chosen=plays[choice] ?? plays[0];
 function play(p:Play){const action:ClientGameAction={type:'play',cards:p.cards,combo:{type:p.combo.type,key:p.combo.key,...(p.combo.suit?{suit:p.combo.suit}:{})},wildAssignments:p.wildAssignments}; socket.emit('game:action',action,ack);}
 const validDuty = view?.myDuty==='tribute'? validTributeCards(view.myHand,view.level):view?.myDuty==='return'?validReturnCards(view.myHand,view.level,view.config):[];
 const pos=(offset:number):Seat=>(((room?.you.seat ?? 0)+offset)%4) as Seat;
 function playedAtSeat(seat:Seat){const play=seatPlays[seat],passed=seatPasses[seat];if((!play&&!passed) || !view)return null;const offset=(seat-(room!.you.seat??0)+4)%4;const cards=play?displayPlayCards(play,view.level):[];return <div className={`seat-play seat-play${offset} ${passed?'seat-play-passed':''}`} key={`play-${seat}`}>{play&&<div className="played card-row" aria-label={`${room!.seats[seat].nickname} 出牌：${cards.map(cardLabel).join('，')}`} style={{...cardRowStyle(cards.length), '--portrait-play-width': `${Math.max(cards.length - 1, 0) * 11}px`} as React.CSSProperties}>{cards.map(c=><span className={`mini-card ${cardOf(c).suit==='H'||cardOf(c).suit==='D'||cardOf(c).rank===17?'red':''}`} key={c}><CardCorner card={c} compactJoker/></span>)}</div>}{passed&&<span className="seat-pass" aria-label={`${room!.seats[seat].nickname} 不要`}>不要</span>}</div>;}
 function seatPanel(seat:Seat){const s=room!.seats[seat];return <div className={`seat seat${(seat-(room!.you.seat??0)+4)%4}`} key={seat}><div className="seat-info"><strong>{s.nickname||`空座位 ${seat+1}`}</strong><small>{s.kind==='human'&&!s.connected?'离线 · ':''}{view?`${dealing ? dealtCount : view.handCounts[seat]} 张${!dealing&&view.turn===seat?' · 行动中':''}`:s.kind==='bot'?'机器人':s.kind==='human'?'已入座':'等待入座'}</small></div>{!game && s.kind==='empty' && <div className="seat-actions"><button onClick={()=>socket.emit('room:sit',{seat},ack)}>入座</button>{room!.hostId===session?.playerId&&<button onClick={()=>socket.emit('room:addBot',{seat},ack)}>加机器人</button>}</div>}{!game && s.kind==='bot'&&room!.hostId===session?.playerId&&<button onClick={()=>socket.emit('room:removeBot',{seat},ack)}>移除</button>}</div>}
 const connectionStatus=<span className={`connection-dot ${connected?'online':''}`} role="status" aria-label={connected?'已连接':'正在重连'} title={connected?'已连接':'正在重连'}/>;
 return <main className={`${view ? 'in-game' : room ? 'in-room' : ''}${sixRowLayout ? ' six-row-layout' : ''}`}>{error&&<div role="alert" className="error" onClick={()=>setError('')}>{error} ×</div>}
 {!room?<section className="welcome"><p className="eyebrow">FOUR PLAYERS · TWO TEAMS {connectionStatus}</p><h2>坐下来，<br/>打把掼蛋。</h2><p>与朋友组队，或邀请机器人补位。房间内的游戏由服务器裁定。</p><label>你的昵称<input value={nickname} maxLength={16} onChange={e=>setNickname(e.target.value)} onBlur={()=>socket.emit('profile:rename',{nickname},ack)}/></label><div className="actions"><button className="primary" disabled={!connected} onClick={()=>socket.emit('room:create',{},r=>{ack(r);if(r.ok)setRoom(r.data);})}>创建房间 →</button><input placeholder="输入房间号" value={roomId} onChange={e=>setRoomId(e.target.value.toUpperCase())}/><button disabled={!connected} onClick={()=>socket.emit('room:join',{roomId},r=>{ack(r);if(r.ok)setRoom(r.data);})}>加入房间</button></div></section>:<><div className={`room-layout ${chatOpen?'chat-visible':''}`}><div className="room-content"><div className="table">{[2,3,1,0].map(i=>seatPanel(pos(i)))}{view&&!dealing&&[2,3,1,0].map(i=>playedAtSeat(pos(i)))}{dealing&&<div className={`deal-animation ${shuffling?'shuffling':'dealing'}`} aria-hidden="true"><span className="deck-card deck-card1"/><span className="deck-card deck-card2"/><span className="deck-card deck-card3"/>{!shuffling&&[0,1,2,3].map(i=><span className={`flying-card flying-card${i}`} key={i}/>)}</div>}<div className="center">{view?<><span className="eyebrow">第 {view.handNo} 局<span className="center-level"> · 级牌 {view.level===14?'A':view.level}</span></span><h2>{dealing?(shuffling?'正在洗牌':'正在发牌'):view.trick?.lastPlay?`${room.seats[view.trick.lastPlay.seat].nickname} 出牌`:'等待首出'}</h2><p>{dealing?(shuffling?'请稍候':`${dealtCount} / ${DEAL_ANIMATION.cardsPerPlayer}`):view.trick?.lastPlay?comboLabel(view.trick.lastPlay.play.combo):view.phase==='tribute'?'进贡阶段':view.phase==='return'?'还贡阶段':'队友坐在对面'}</p></>:<><span className="eyebrow">THE TABLE IS READY</span><h2>好牌，慢慢打。</h2><p>选择座位，邀请好友或添加机器人</p></>}</div></div>
 {view&&<section className="hand"><div className="hand-head"><div><span className="eyebrow">YOUR HAND</span><h2>你的手牌 <small>{visibleHand.length} 张</small><span className="hand-level">{displayedLevelTeam == null ? '双方' : displayedLevelTeam === view.seat % 2 ? '我方' : '对方'}打 {rankLabel(displayedLevel!)}</span></h2></div><span>{dealing?(shuffling?'正在洗牌':'正在发牌'):view.myDuty==='play'?'轮到你出牌':view.myDuty==='tribute'?'请选择最大牌进贡':view.myDuty==='return'?'请选择还贡牌':'等待其他玩家'}</span></div><div className="cards card-row" style={{...cardRowStyle(visibleHand.length), '--hand-grid': cardRowStyle(handLayout.columns).gridTemplateColumns, '--card-count': handLayout.columns, '--hand-width': `${Math.max(handLayout.columns - 1, 0) * 26}px`} as React.CSSProperties}>{handLayout.cards.map(({card:c,group,label,row,column})=><button key={c} type="button" disabled={!!dealing} aria-label={`${cardLabel(c)}${isWild(c,view.level)?'，逢人配':''}${label?`，建议牌组：${label}`:''}`} aria-pressed={selected.includes(c)} style={{'--portrait-row':row,'--portrait-column':column} as React.CSSProperties} className={`card ${!dealing&&group%2?'group-raised':''} ${dealing?'arriving':''} ${selected.includes(c)?'selected':''} ${cardOf(c).suit==='H'||cardOf(c).suit==='D'||cardOf(c).rank===17?'red':''} ${validDuty.includes(c)?'eligible':''}`} onClick={()=>{setChoice(0);setSelected(x=>x.includes(c)?x.filter(y=>y!==c):[...x,c]);}}><CardCorner card={c} wild={isWild(c,view.level)}/></button>)}</div>{!dealing&&<div className="controls">{view.myDuty==='play'&&<>{selected.some(card=>isWild(card,view.level))&&<label className="wild-choice">万能牌变为：<select value={choice} onChange={e=>setChoice(Number(e.target.value))}>{plays.length===0?<option>无可出的牌</option>:plays.map((p,i)=><option key={i} value={i}>{comboLabel(p.combo)}{p.wildAssignments.length?' · '+p.wildAssignments.map(w=>`${cardLabel(w.cardId)} → ${suitLabel(w.suit)}${rankLabel(w.rank)}`).join(', '):''}</option>)}</select></label>}<button className="primary" disabled={!chosen} onClick={()=>chosen&&play(chosen)}>出牌</button></>}{view.phase==='playing'&&<button disabled={view.myDuty!=='play'||!view.trick?.lastPlay} title={view.myDuty!=='play'?'请等待你的回合':!view.trick?.lastPlay?'首出时必须出牌':'跳过本次出牌'} onClick={()=>socket.emit('game:action',{type:'pass'},ack)}>不要</button>}{(view.myDuty==='tribute'||view.myDuty==='return')&&<button className="primary" disabled={selected.length!==1||!validDuty.includes(selected[0]!)} onClick={()=>socket.emit('game:action',{type:view.myDuty==='tribute'?'tribute':'returnTribute',card:selected[0]!},ack)}>{view.myDuty==='tribute'?'确认进贡':'确认还贡'}</button>}<button onClick={()=>socket.emit('game:autoplay',{on:!room.seats[view.seat].autoPlay},ack)}>{room.seats[view.seat].autoPlay?'取消托管':'托管'}</button></div>}{!dealing&&view.antiTribute&&<div className="tribute-info" aria-label="抗贡记录"><p>{view.antiTribute.map(seat=>room.seats[seat].nickname).join("、")} 抗贡</p></div>}{!dealing&&view.tribute&&<TributeInfo tribute={view.tribute} seat={view.seat} publicReturnCard={view.config.publicReturnCard} seats={room.seats}/>}{view.lastResult && (view.phase==='handOver'||view.phase==='matchOver')&&<div className="result"><h2>{view.phase==='matchOver'?`队伍 ${view.matchWinner!+1} 赢得比赛`:'本局结算'}</h2><p>名次：{view.lastResult.finishOrder.map(s=>room.seats[s].nickname).join(' → ')} · 队伍 {view.lastResult.winTeam+1} 升 {view.lastResult.upgrade} 级</p>{view.phase==='handOver'&&game?.deadline!=null&&<ReadyButton ready={room.seats[view.seat].readyForNext} deadline={game.deadline} serverNow={game.serverNow} onToggle={()=>socket.emit('game:ready',ack)}/>}</div>}</section>}</div><ChatPanel key={room.roomId} roomId={room.roomId} playerId={room.you.playerId} connected={connected} open={chatOpen} onUnread={setUnreadRoom} onTouchStart={startChatSwipe} onTouchEnd={endChatSwipe} onTouchCancel={()=>{swipeStart.current=null;}}/>{!chatOpen&&<div className="chat-swipe-edge" aria-hidden="true" onTouchStart={startChatSwipe} onTouchEnd={endChatSwipe} onTouchCancel={()=>{swipeStart.current=null;}}/>}</div><div className="roombar"><div><span className="eyebrow">ROOM</span><strong className="roomid">{room.roomId}</strong>{connectionStatus}<span>分享房间号邀请好友</span></div><div className="room-actions"><button type="button" className="portrait-layout-toggle" aria-pressed={sixRowLayout} onClick={()=>setSixRowLayout(current=>{const next=!current;localStorage.setItem('guandan-portrait-layout',next?'six-rows':'table');return next;})}>六行布局</button><button type="button" className="chat-toggle" aria-controls="room-chat" aria-expanded={chatOpen} aria-label={unreadRoom===room.roomId && !chatOpen?"群聊，有新消息":"群聊"} onClick={()=>openChat(!chatOpen)}>群聊{unreadRoom===room.roomId && !chatOpen && <span className="chat-unread" aria-hidden="true"/>}</button>{!view&&room.hostId===session?.playerId&&<button className="primary" onClick={()=>socket.emit('room:start',ack)}>开始游戏</button>}<button onClick={()=>socket.emit('room:leave',ack)}>离开房间</button></div></div></>}
 {!room&&<footer>掼蛋俱乐部 <span>·</span> 双副牌 · 四人对战</footer>}</main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
