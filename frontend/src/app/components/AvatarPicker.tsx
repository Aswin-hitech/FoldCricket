import { ACCOUNT_AVATARS } from '../../services/accounts'
import styles from './AvatarPicker.module.css'

interface AvatarPickerProps {
  value: string
  onChange: (avatar: string) => void
  disabled?: boolean
}

export function AvatarPicker({ value, onChange, disabled }: AvatarPickerProps) {
  return (
    <div className={styles.picker} role="radiogroup" aria-label="Choose an avatar">
      {ACCOUNT_AVATARS.map((avatar) => (
        <button
          key={avatar}
          type="button"
          role="radio"
          aria-checked={value === avatar}
          aria-label={`Avatar ${avatar}`}
          className={`${styles.avatar} ${value === avatar ? styles.avatarActive : ''}`}
          onClick={() => onChange(avatar)}
          disabled={disabled}
        >
          {avatar}
        </button>
      ))}
    </div>
  )
}
