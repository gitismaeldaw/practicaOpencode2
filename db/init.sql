CREATE TABLE libros (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  autor TEXT NOT NULL,
  precio NUMERIC(6,2) NOT NULL
);

CREATE TABLE pedidos (
  id SERIAL PRIMARY KEY,
  libro_id INTEGER REFERENCES libros(id),
  unidades INTEGER NOT NULL,
  creado TIMESTAMP DEFAULT now()
);

INSERT INTO libros (titulo, autor, precio) VALUES
  ('El Quijote', 'Miguel de Cervantes', 19.90),
  ('Rayuela', 'Julio Cortázar', 15.50),
  ('La colmena', 'Camilo José Cela', 12.00);
