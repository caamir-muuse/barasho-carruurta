Optional bundled lesson audio.

The app prefers audio from the backend when available:
  backend_spring/src/main/resources/static/media/lessons/

Expected lesson MP3 files (see backend README):
  so_alphabet.mp3, so_numbers.mp3
  en_alphabet.mp3, en_numbers.mp3
  ar_alphabet.mp3
  diin_wudu.mp3, diin_pillars.mp3
  adab_greeting.mp3, adab_parents.mp3, adab_eating.mp3

Quran surah audio (001.mp3 ... 114.mp3):
  backend_spring/src/main/resources/static/media/quran/

You can also add local copies here using the names referenced in dummy_data.dart
(for example so_lesson1.mp3) if you want offline playback without the API.
