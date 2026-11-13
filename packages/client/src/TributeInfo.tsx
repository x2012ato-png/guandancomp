import { cardLabel, type Seat, type TributeView } from '@guandan/engine';

interface TributeInfoProps {
  tribute: TributeView;
  seat: Seat;
  publicReturnCard: boolean;
  seats: readonly { readonly nickname: string | null }[];
}

export function TributeInfo({ tribute, seat, publicReturnCard, seats }: TributeInfoProps) {
  return <div className="tribute-info" aria-label="进贡和还贡记录">
    {tribute.links.length > 0 ? tribute.links.map(link => <p key={link.from}>
      {seats[link.from]?.nickname} 向 {seats[link.to]?.nickname} 进贡 {cardLabel(link.card)}
      {link.returned && link.returnCard !== null && (publicReturnCard || seat === link.from) &&
        <>；{seats[link.to]?.nickname} 向 {seats[link.from]?.nickname} 还贡 {cardLabel(link.returnCard)}</>}
    </p>) : tribute.paid.length > 0 ? tribute.paid.map(p => <p key={p.from}>
      {seats[p.from]?.nickname} 进贡 {cardLabel(p.card)}（等待确定接收方）
    </p>) : <p>等待进贡</p>}
  </div>;
}
