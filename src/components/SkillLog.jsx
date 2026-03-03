export default function SkillLog({ skills }) {
  return (
    <div className="glass-inset">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Skill Log</h3>
        <span className="muted-text">{skills.length}</span>
      </div>
      <ul className="max-h-36 space-y-1 overflow-y-auto text-sm">
        {skills.length === 0 ? <li className="muted-text">No saved skills yet.</li> : null}
        {skills.map((skill) => (
          <li key={`${skill.domain}-${skill.filename}`} className="feed-item">
            <p className="font-medium">{skill.name}</p>
            <p className="muted-text">{skill.domain}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
