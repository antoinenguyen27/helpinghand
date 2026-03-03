export default function StatusFeed({ items }) {
  return (
    <div className="glass-inset status-feed">
      <div className="space-y-2 text-sm">
        {items.length === 0 ? <p className="muted-text">No activity yet.</p> : null}
        {items.map((item) => (
          <div key={item.id} className="feed-item">
            <p className="feed-item-type">{item.type}</p>
            <p>{item.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
